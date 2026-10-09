// Prize classification, unknown costs, expected/worst-case costs, sponsored budgets and liabilities.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin } from "./fixtures.mjs";

let db, admin, prizes;
before(async () => {
  db = await freshDb("econ");
  admin = await makeAdmin(db);
});
after(async () => db?.close());

const status = async () => (await db.rpc("economics_status"))[0].economics_status;
const estimate = async () => (await db.rpc("draw_cost_estimate"))[0].draw_cost_estimate;

test("seeded pool: unknown costs are 'unverified', never zero; VIP/Gold seed numbers are not proof", async () => {
  await db.q(`update prizes set onchain_index = case name when 'Banana Chip' then 0 when 'Silver Crate' then 1 when 'Gold Crate' then 2 else 3 end`);
  const est = await estimate();
  assert.equal(est.verified, false);
  assert.equal(est.expected_cost_per_spin_usd, null);
  assert.ok(est.unverified.some((x) => /prize:Banana Chip/.test(x)));
  const issues = (await db.rpc("prize_pool_issues")).map((r) => `${r.prize_name}: ${r.issue}`);
  assert.ok(issues.some((i) => /Charleston VIP Pass: Real prize: stock not verified/.test(i)));
  assert.ok(issues.some((i) => /Banana Chip: Unlimited stock/.test(i)));
  const s = await status();
  assert.equal(s.purchases_allowed, false);
  assert.ok(s.purchase_blockers.length >= 2);
  // Real prizes can never be unlimited.
  await rejects(db.q(`update prizes set inventory = null where name = 'Gold Crate'`), /prizes_real_need_stock/);
});

test("expected and worst-case cost come from the prizes actually still available", async () => {
  prizes = await cleanPool(db); // costs 0/0/10/100, weights 600/280/100/20
  await db.q(`update operating_costs set amount_usd = 0.05, verified = true where key in ('vrf_per_spin')`);
  await db.q(`update operating_costs set amount_usd = 0, verified = true where key in ('gas_per_spin', 'provider_per_spin')`);
  let est = await estimate();
  assert.equal(est.verified, true);
  assert.equal(est.expected_prize_cost_usd, "3.0000"); // (100*10 + 20*100) / 1000
  assert.equal(est.expected_cost_per_spin_usd, "3.0500");
  assert.equal(est.worst_case_cost_per_spin_usd, "100.0500");
  // Legendary sold out -> probabilities and costs change.
  await db.q(`update prizes set inventory = 0 where id = $1`, [prizes["Charleston VIP Pass"]]);
  est = await estimate();
  assert.equal(est.available_weight, "980");
  assert.equal(est.expected_prize_cost_usd, "1.0204"); // 1000 / 980
  assert.equal(est.worst_case_cost_per_spin_usd, "10.0500");
  await db.q(`update prizes set inventory = 20 where id = $1`, [prizes["Charleston VIP Pass"]]);
});

test("purchases need a prize reserve covering every remaining real prize plus pending fulfillment", async () => {
  let s = await status();
  assert.equal(s.liabilities.remaining_real_prize_stock_usd, "7000.0000"); // 500*10 + 20*100
  assert.equal(s.purchases_allowed, false);
  await db.q(`insert into funding_events(account, amount_usd, evidence, created_by) values ('prize_reserve', 6999.99, 'bank transfer #1', $1)`, [admin]);
  assert.equal((await status()).purchases_allowed, false);
  await db.q(`insert into funding_events(account, amount_usd, evidence, created_by) values ('prize_reserve', 0.01, 'bank transfer #2', $1)`, [admin]);
  s = await status();
  assert.equal(s.purchases_allowed, true, JSON.stringify(s.purchase_blockers));
  // Funding history is append-only.
  await rejects(db.q(`update funding_events set amount_usd = 1`), /append-only/);
  await rejects(db.q(`delete from funding_events`), /append-only/);
});

test("sponsored credits reserve worst-case cost atomically; exhaustion and low water pause new grants", async () => {
  const u = await db.createUser();
  await rejects(db.rpc("issue_sponsored_credits", [u, "grant", 1, null, admin, {}]), /paused/);
  await db.q(`insert into funding_events(account, amount_usd, evidence, created_by) values ('sponsored_grant', 250, 'marketing budget', $1)`, [admin]);
  await db.q(`update sponsored_budgets set paused = false, pause_reason = null, low_water_usd = 40 where source = 'grant'`);
  const [{ issue_sponsored_credits: ids }] = await db.rpc("issue_sponsored_credits", [u, "grant", 2, "promo", admin, {}]);
  assert.equal(ids.length, 2);
  let b = await db.one(`select committed_usd, paused from sponsored_budgets where source = 'grant'`);
  assert.equal(Number(b.committed_usd), 200.1); // 2 x 100.05 worst case
  assert.equal(b.paused, false);
  // 49.90 left < 100.05 needed -> nothing issued, budget paused, alert raised (and kept).
  const [{ issue_sponsored_credits: none }] = await db.rpc("issue_sponsored_credits", [u, "grant", 1, null, admin, {}]);
  assert.deepEqual(none, []);
  b = await db.one(`select committed_usd, paused, pause_reason from sponsored_budgets where source = 'grant'`);
  assert.equal(b.paused, true);
  assert.ok(await db.one(`select 1 from ops_alerts where kind = 'budget_exhausted' and subject = 'grant' and resolved_at is null`));
  await rejects(db.rpc("issue_sponsored_credits", [u, "grant", 1, null, admin, {}]), /paused/);
  assert.equal((await db.one(`select count(*)::int n from spin_credits where user_id = $1`, [u])).n, 2);
});

test("unknown costs block sponsored grants", async () => {
  const u = await db.createUser();
  await db.q(`update operating_costs set verified = false where key = 'vrf_per_spin'`);
  await db.q(`update sponsored_budgets set paused = false where source = 'grant'`);
  await rejects(db.rpc("issue_sponsored_credits", [u, "grant", 1, null, admin, {}]), /verified costs/);
  await db.q(`update operating_costs set verified = true where key = 'vrf_per_spin'`);
});

test("liabilities: pending fulfillments and unused credits are reported", async () => {
  const s = await status();
  assert.ok(s.liabilities.unused_credits >= 2);
  assert.ok(s.liabilities.unused_credits_worst_case_usd);
  assert.equal(s.liabilities.pending_fulfillment_count, 0);
});
