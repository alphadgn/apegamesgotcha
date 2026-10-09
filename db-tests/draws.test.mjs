// Draw reservation, submission bookkeeping, settlement, scoring and inventory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin, activeSeason, giveCredits, confirmedBatch, hex, CHAIN, CONTRACT } from "./fixtures.mjs";

let db, admin, season, prizes;
before(async () => {
  db = await freshDb("draws");
  prizes = await cleanPool(db);
  admin = await makeAdmin(db);
  season = await activeSeason(db, admin);
});
after(async () => db?.close());

const reserve = (u, n, key = randomUUID()) =>
  db.rpc("reserve_draw_batch", [u, n, key, CHAIN, CONTRACT, 1]).then((r) => r[0].reserve_draw_batch);
const settle = (spin, idx, req, word = "123") => db.rpc("settle_drawn_spin", [spin, idx, word, req, 200, hex()]).then((r) => r[0]);
const total = async (u) => (await db.one(`select total_points from season_scores where season_id = $1 and user_id = $2`, [season, u]))?.total_points ?? "0";
const freeMachine = () => db.q(`update draw_coordination set active_batch_id = null`);

test("reservation is idempotent per key and captures season, rule version and bonus map", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 3);
  const key = randomUUID();
  const a = await reserve(u, 2, key);
  const b = await reserve(u, 2, key);
  assert.equal(b.replayed, true);
  assert.equal(b.batch_id, a.batch_id);
  assert.deepEqual(b.spin_ids, a.spin_ids);
  const batch = await db.one(`select * from draw_batches where id = $1`, [a.batch_id]);
  assert.equal(batch.season_id, season);
  assert.equal(batch.participation_points, "10");
  assert.equal(batch.prize_map["0"].bonus, "25");
  assert.equal(batch.prize_map["3"].bonus, "500");
  assert.equal((await db.one(`select count(*)::int n from spin_credits where user_id = $1 and used_spin_id is null`, [u])).n, 1);
  await db.rpc("release_draw_prebroadcast", [a.batch_id, "test"]);
});

test("global serialization: a second batch waits until the first is reconciled", async () => {
  const [u1, u2] = [await db.createUser(), await db.createUser()];
  await giveCredits(db, u1, 1);
  await giveCredits(db, u2, 1);
  const a = await reserve(u1, 1);
  await rejects(reserve(u2, 1), /busy/);
  await db.rpc("release_draw_prebroadcast", [a.batch_id, "simulation failed"]);
  const b = await reserve(u2, 1);
  assert.ok(b.batch_id);
  await db.rpc("release_draw_prebroadcast", [b.batch_id, "cleanup"]);
});

test("rolling 24h limit counts pending reservations; refunds release capacity exactly once", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 12);
  const a = await reserve(u, 10);
  await db.rpc("release_draw_prebroadcast", [a.batch_id, "x"]); // refunded -> capacity back
  const b = await reserve(u, 10);
  // pending reservation counts against the limit
  const { batchId } = await (async () => {
    const tx = hex();
    await db.rpc("record_draw_signed", [b.batch_id, "0x" + "a".repeat(40), 9001, tx, "0xab"]);
    await db.rpc("record_draw_failed", [tx, "reverted", 5, hex(), {}]);
    return { batchId: b.batch_id };
  })();
  // reverted -> refunded once; a second failure report is a no-op
  const again = await db.rpc("record_draw_failed", [(await db.one(`select request_tx from draw_batches where id=$1`, [batchId])).request_tx, "reverted", 5, hex(), {}]);
  assert.equal(again[0].record_draw_failed, 0);
  const free = await db.one(`select count(*)::int n from spin_credits where user_id = $1 and used_spin_id is null`, [u]);
  assert.equal(free.n, 12);
  // Now exhaust the 24h window with real (fulfilled) spins.
  const c = await confirmedBatch(db, u, 10);
  for (const id of c.spinIds) await settle(id, 0, c.requestId);
  await rejects(reserve(u, 1), /24 hours/);
});

test("a signed or ambiguous batch is never refunded as 'pre-broadcast'", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const a = await reserve(u, 1);
  const tx = hex();
  await db.rpc("record_draw_signed", [a.batch_id, "0x" + "a".repeat(40), 7001, tx, "0xab"]);
  await db.rpc("record_draw_broadcast", [tx, "network timeout after send"]);
  assert.equal((await db.one(`select status from draw_batches where id = $1`, [a.batch_id])).status, "ambiguous");
  await rejects(db.rpc("release_draw_prebroadcast", [a.batch_id, "timeout"]), /must be reconciled/);
  // still reserved: the spin stays pending, the credit stays used, the machine stays locked
  assert.equal((await db.one(`select status from spins where batch_id = $1`, [a.batch_id])).status, "pending");
  await rejects(reserve(await db.createUser(), 1), /busy|credits/);
  // Proven dropped (nonce consumed by another tx) -> refund once.
  await db.rpc("record_draw_failed", [tx, "dropped", null, null, { nonce: 7001, replaced_by: hex() }]);
  assert.equal((await db.one(`select status, refund_reason from spins where batch_id = $1`, [a.batch_id])).refund_reason, "request_dropped");
});

test("settlement awards participation + bonus once; replay is a no-op; conflicting replay alerts and pauses", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const c = await confirmedBatch(db, u, 1);
  const sp = await settle(c.spinIds[0], 1, c.requestId, "777");
  assert.equal(sp.status, "fulfilled");
  assert.equal(sp.participation_points, "10");
  assert.equal(sp.bonus_points, "100");
  assert.equal(await total(u), "110");
  await settle(c.spinIds[0], 1, c.requestId, "777"); // replay
  assert.equal(await total(u), "110");
  const conflicted = await settle(c.spinIds[0], 2, c.requestId, "777");
  assert.equal(conflicted.prize_index, 1); // unchanged
  assert.ok(await db.one(`select 1 from ops_alerts where kind = 'result_conflict' and subject = $1`, [c.spinIds[0]]));
  const coord = await db.one(`select requests_paused from draw_coordination`);
  assert.equal(coord.requests_paused, true);
  await db.q(`update draw_coordination set requests_paused = false, pause_reason = null`);
});

test("NO_PRIZE returns the credit once and scores zero", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const c = await confirmedBatch(db, u, 1);
  const sp = await settle(c.spinIds[0], 255, c.requestId);
  assert.equal(sp.status, "refunded");
  assert.equal(sp.refund_reason, "no_prize");
  await settle(c.spinIds[0], 255, c.requestId); // replay
  const credits = await db.q(`select used_spin_id from spin_credits where user_id = $1`, [u]);
  assert.equal(credits.filter((x) => x.used_spin_id === null).length, 1);
  assert.equal(await total(u), "0");
});

test("a request confirmed at/after the exclusive cutoff keeps the prize but earns no seasonal points", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const { ends_at } = await db.one(`select ends_at::text from seasons where id = $1`, [season]);
  const c = await confirmedBatch(db, u, 1, { blockTime: ends_at });
  const sp = await settle(c.spinIds[0], 3, c.requestId);
  assert.equal(sp.status, "fulfilled");
  assert.equal(sp.prize_name, "Charleston VIP Pass");
  assert.equal(sp.seasonal_eligible, false);
  assert.equal(await total(u), "0");
  // The real prize is still owed.
  assert.ok(await db.one(`select 1 from prize_fulfillments where spin_id = $1`, [sp.id]));
});

test("pending, refunded and unconfirmed spins score zero; settle refuses unconfirmed requests", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const a = await reserve(u, 1);
  const tx = hex();
  await db.rpc("record_draw_signed", [a.batch_id, "0x" + "a".repeat(40), 8001, tx, "0xab"]);
  await rejects(settle(a.spin_ids[0], 0, "1"), /not canonically confirmed/);
  assert.equal(await total(u), "0");
  await db.rpc("record_draw_failed", [tx, "reverted", 1, hex(), {}]);
});

test("captured rules win over later config/prize edits (rule freeze)", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const c = await confirmedBatch(db, u, 1);
  // Admin edits after reservation: rename the prize and change rarity; season rules are frozen anyway.
  await db.q(`update prizes set rarity = 'legendary', name = 'Renamed' where id = $1`, [prizes["Banana Chip"]]);
  await rejects(db.q(`update seasons set rules = jsonb_set(rules, '{points,participation_per_spin}', '"999"') where id = $1`, [season]), /frozen/);
  const sp = await settle(c.spinIds[0], 0, c.requestId);
  assert.equal(sp.rarity, "common");
  assert.equal(sp.prize_name, "Banana Chip");
  assert.equal(sp.bonus_points, "25");
  await db.q(`update prizes set rarity = 'common', name = 'Banana Chip' where id = $1`, [prizes["Banana Chip"]]);
});

test("concurrent reservations: one batch per key, the machine serializes the rest", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 5);
  const key = randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve(u, 1, key)));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((x) => x.batch_id)).size, 1);
  assert.equal((await db.one(`select count(*)::int n from draw_batches where user_id = $1`, [u])).n, 1);
  const other = await Promise.allSettled([reserve(u, 1), reserve(u, 1)]);
  assert.ok(other.every((r) => r.status === "rejected"));
  await db.rpc("release_draw_prebroadcast", [ok[0].batch_id, "cleanup"]);
});

test("scarce inventory: entitlement kept and drift alerted when the DB has no stock left", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  await db.q(`update prizes set inventory = 0 where id = $1`, [prizes["Charleston VIP Pass"]]);
  const c = await confirmedBatch(db, u, 1);
  const sp = await settle(c.spinIds[0], 3, c.requestId);
  assert.equal(sp.status, "fulfilled");
  assert.equal(sp.prize_name, "Charleston VIP Pass");
  const inv = await db.one(`select inventory from prizes where id = $1`, [prizes["Charleston VIP Pass"]]);
  assert.equal(inv.inventory, 0);
  assert.ok(await db.one(`select 1 from ops_alerts where kind = 'inventory_drift' and resolved_at is null`));
  await db.q(`update prizes set inventory = 20 where id = $1`, [prizes["Charleston VIP Pass"]]);
});

test("closed browser: settlement works from the server without the player (worker path)", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 2);
  const c = await confirmedBatch(db, u, 2);
  // Nothing from the player's session is needed — only service-role calls with chain data.
  for (const id of c.spinIds) await settle(id, 1, c.requestId);
  const rows = await db.q(`select status from spins where batch_id = $1`, [c.batchId]);
  assert.deepEqual(rows.map((r) => r.status), ["fulfilled", "fulfilled"]);
});

test("event/batch mismatch on confirmation pauses requests", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const a = await reserve(u, 1);
  const tx = hex();
  await db.rpc("record_draw_signed", [a.batch_id, "0x" + "a".repeat(40), 9901, tx, "0xab"]);
  const [{ confirm_draw_request: out }] = await db.rpc("confirm_draw_request", [tx, "5", 10, hex(), new Date(), 3, [randomUUID()]]);
  assert.equal(out, "conflict");
  assert.equal((await db.one(`select requests_paused from draw_coordination`)).requests_paused, true);
  assert.equal((await db.one(`select status from draw_batches where id = $1`, [a.batch_id])).status, "signed");
  await db.q(`update draw_coordination set requests_paused = false, pause_reason = null`);
  await db.rpc("record_draw_failed", [tx, "reverted", 1, hex(), {}]);
});

test("pool publication: blocked while a draw is in flight; never refills consumed stock from stale DB values", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const a = await reserve(u, 1);
  await rejects(db.rpc("begin_pool_publication", [CHAIN, CONTRACT, "[]", admin]), /in flight|Unreconciled/);
  await db.rpc("release_draw_prebroadcast", [a.batch_id, "x"]);
  await freeMachine();
  // DB says 500 Gold Crates, chain says 480 remain: publish 480 (and alert), never 500.
  await db.q(`update prizes set inventory = 500 where id = $1`, [prizes["Gold Crate"]]);
  const U = 4294967295;
  const [{ begin_pool_publication: plan }] = await db.rpc("begin_pool_publication", [CHAIN, CONTRACT, JSON.stringify([U, U, 480, 20]), admin]);
  assert.deepEqual(plan.remaining.map(Number), [U, U, 480, 20]);
  assert.equal((await db.one(`select inventory from prizes where id = $1`, [prizes["Gold Crate"]])).inventory, 480);
  // A second publication cannot start; draws are locked out while publishing.
  await rejects(db.rpc("begin_pool_publication", [CHAIN, CONTRACT, "[]", admin]), /already in progress/);
  await giveCredits(db, u, 1);
  await rejects(reserve(u, 1), /being published/);
  await db.rpc("finish_pool_publication", [plan.publication_id, true, hex(), 2, null]);
  // An audited restock is the only way above chain stock.
  await db.rpc("adjust_prize_stock", [prizes["Gold Crate"], 10, "received 10 more crates", admin]);
  const [{ begin_pool_publication: plan2 }] = await db.rpc("begin_pool_publication", [CHAIN, CONTRACT, JSON.stringify([U, U, 480, 20]), admin]);
  assert.equal(Number(plan2.remaining[2]), 490);
  await db.rpc("finish_pool_publication", [plan2.publication_id, false, null, null, "aborted in test"]);
});

test("season spin limit (100) counts only this season's non-refunded spins", async () => {
  const u = await db.createUser();
  // Fabricate 100 fulfilled season spins directly (fast); limit check must see them.
  await giveCredits(db, u, 101);
  const credits = await db.q(`select id from spin_credits where user_id = $1 order by created_at limit 100`, [u]);
  for (const c of credits) {
    await db.q(`insert into spins(user_id, credit_id, status, season_id, created_at) values ($1, $2, 'fulfilled', $3, now() - interval '2 days')`, [u, c.id, season]);
    await db.q(`update spin_credits set used_spin_id = (select id from spins where credit_id = $1) where id = $1`, [c.id]);
  }
  await rejects(reserve(u, 1), /Season spin limit/);
});
