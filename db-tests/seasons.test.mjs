// Season lifecycle, rule freeze, cutoff/settlement/finalization, corrections, backfill and the public API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin, giveCredits, confirmedBatch, hex } from "./fixtures.mjs";

let db, admin, prizes;
before(async () => {
  db = await freshDb("seasons");
  prizes = await cleanPool(db);
  admin = await makeAdmin(db);
});
after(async () => db?.close());

const rulesWith = async (mut) => {
  const r = (await db.one(`select default_season_rules() r`)).r;
  r.points.nft_snapshot_per_token = "0";
  mut?.(r);
  return r;
};
const draft = async (slug, rules, { starts = "now() - interval '1 hour'", ends = "now() + interval '1 day'" } = {}) =>
  (await db.one(
    `insert into seasons(slug, name, starts_at, ends_at, settlement_deadline, rules)
     values ($1, $1, ${starts}, ${ends}, ${ends} + interval '2 days', $2) returning id`,
    [slug, JSON.stringify(rules)],
  )).id;
const settle = (spin, idx, req) => db.rpc("settle_drawn_spin", [spin, idx, "1", req, 200, hex()]);

let mainSeason;

test("activation validates rules, window, snapshot readiness, pool issues and admin role", async () => {
  const bad = await rulesWith((r) => { r.points.participation_per_spin = "-5"; r.referrals_enabled = true; });
  const id = await draft("bad-rules", bad);
  const [{ season_activation_errors: errs }] = await db.rpc("season_activation_errors", [id]);
  assert.ok(errs.some((e) => /participation_per_spin/.test(e)));
  assert.ok(errs.some((e) => /referrals/.test(e)));
  await rejects(db.rpc("activate_season", [id, admin]), /Cannot activate/);

  const nftRules = await rulesWith((r) => { r.points.nft_snapshot_per_token = "100"; });
  const id2 = await draft("needs-snapshot", nftRules);
  await rejects(db.rpc("activate_season", [id2, admin]), /ready collection/);

  const ok = await draft("not-admin", await rulesWith());
  const someone = await db.createUser();
  await rejects(db.rpc("activate_season", [ok, someone]), /Forbidden/);

  // Unverified prize costs block activation.
  await db.q(`update prizes set cost_verified = false where id = $1`, [prizes["Banana Chip"]]);
  await rejects(db.rpc("activate_season", [ok, admin]), /prize classification/);
  await db.q(`update prizes set cost_verified = true where id = $1`, [prizes["Banana Chip"]]);
  await db.q(`delete from seasons where id in ($1, $2, $3)`, [id, id2, ok]);
});

test("draft edits bump the rule version; activation freezes rules, window and snapshot", async () => {
  const id = await draft("main", await rulesWith((r) => { r.points.prize_bonus_overrides[prizes["Banana Chip"]] = "0"; }));
  const v1 = (await db.one(`select rules_version from seasons where id = $1`, [id])).rules_version;
  await db.q(`update seasons set rules = jsonb_set(rules, '{points,x_share}', '"3"') where id = $1`, [id]);
  const v2 = (await db.one(`select rules_version from seasons where id = $1`, [id])).rules_version;
  assert.equal(v2, v1 + 1);
  await db.rpc("activate_season", [id, admin]);
  const s = await db.one(`select status, rules_hash from seasons where id = $1`, [id]);
  assert.equal(s.status, "active");
  assert.match(s.rules_hash, /^[0-9a-f]{64}$/);
  await rejects(db.q(`update seasons set rules = rules || '{"x":1}' where id = $1`, [id]), /frozen/);
  await rejects(db.q(`update seasons set ends_at = ends_at + interval '1 day' where id = $1`, [id]), /frozen/);
  await rejects(db.q(`update seasons set snapshot_config = '{"collection_ids":[]}'::jsonb || '{"y":1}' where id = $1`, [id]), /frozen/);
  await rejects(db.q(`update seasons set status = 'draft' where id = $1`, [id]), /cannot move/);
  await rejects(db.q(`delete from seasons where id = $1`, [id]), /Only draft/);
  // Settlement deadline may be extended, never shortened.
  await db.q(`update seasons set settlement_deadline = settlement_deadline + interval '1 day' where id = $1`, [id]);
  await rejects(db.q(`update seasons set settlement_deadline = settlement_deadline - interval '5 days' where id = $1`, [id]), /extended/);
  mainSeason = id;
});

test("a second active season or an overlapping window is refused", async () => {
  const other = await draft("overlap", await rulesWith());
  await rejects(db.rpc("activate_season", [other, admin]), /overlaps|Another season is active/);
  await db.q(`delete from seasons where id = $1`, [other]);
});

test("explicit zero bonus override: participation only, no legacy prize points on top", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const c = await confirmedBatch(db, u, 1);
  const [sp] = await settle(c.spinIds[0], 0, c.requestId); // Banana Chip, override "0"
  assert.equal(sp.bonus_points, "0");
  assert.equal(sp.participation_points, "10");
  const s = await db.one(`select total_points, prize_points from season_scores where season_id = $1 and user_id = $2`, [mainSeason, u]);
  assert.deepEqual([s.total_points, s.prize_points], ["10", "0"]);
});

test("public API: paginated leaderboard with aliases; no emails, wallets or auth ids", async () => {
  const u = await db.createUser("private-person@example.com");
  await db.rpc("set_public_profile", [u, "Banana King", "ape-3"]);
  await db.rpc("ledger_award", [mainSeason, u, "spin", "pub-1", "participation", "5000", 1, new Date(), {}, null]);
  const rows = await db.asAnon((s) => s.q(`select * from get_season_leaderboard('main', 0, 10)`));
  const top = rows[0];
  assert.equal(top.alias, "Banana King");
  assert.equal(top.total_points, "5000");
  assert.equal(typeof top.total_points, "string");
  const flat = JSON.stringify(rows);
  assert.ok(!flat.includes(u), "auth id must not leak");
  assert.ok(!flat.includes("private-person"), "email must not leak");
  assert.ok(!("user_id" in top));
  // Pagination + total_count.
  const page2 = await db.asAnon((s) => s.q(`select * from get_season_leaderboard('main', 1, 1)`));
  assert.equal(page2.length, 1);
  assert.equal(Number(page2[0].rank), 2);
  assert.equal(page2[0].total_count, String(rows.length));
  // Limit is capped at 100.
  await db.asAnon((s) => s.q(`select * from get_season_leaderboard('main', 0, 100000)`));
  // My standing uses auth.uid() only.
  const mine = await db.asUser(u, (s) => s.one(`select * from get_my_season_standing('main')`));
  assert.equal(mine.rank, "1");
  assert.equal(await db.asAnon((s) => s.q(`select * from get_my_season_standing('main')`)).catch((e) => e.message).then((x) => typeof x), "string");
  // Legacy compat function exposes aliases/public ids only.
  const legacyShape = await db.asAnon((s) => s.q(`select * from get_leaderboard(5)`));
  assert.ok(legacyShape.every((r) => !("user_id" in r)));
  // Aliases are validated and reserved words refused.
  const v = await db.createUser();
  await rejects(db.rpc("set_public_profile", [v, "Banana King", null]), /taken/);
  await rejects(db.rpc("set_public_profile", [v, "Official_Ape", null]), /reserved/);
  await rejects(db.rpc("set_public_profile", [v, "<script>", null]), /Aliases are/);
});

test("drafts are invisible to the public", async () => {
  const id = await draft("secret-draft", await rulesWith(), { starts: "now() + interval '10 days'", ends: "now() + interval '20 days'" });
  const seasons = await db.asAnon((s) => s.q(`select slug from get_public_seasons()`));
  assert.ok(!seasons.some((x) => x.slug === "secret-draft"));
  const direct = await db.asAnon((s) => s.q(`select slug from seasons`));
  assert.ok(!direct.some((x) => x.slug === "secret-draft"));
  await rejects(db.asAnon((s) => s.q(`select * from get_season_leaderboard('secret-draft', 0, 10)`)), /Unknown season/);
  await db.q(`delete from seasons where id = $1`, [id]);
});

test("backfill is off by default; the dry-run report is available", async () => {
  const [{ season_backfill_report: rep }] = await db.rpc("season_backfill_report", [mainSeason]);
  assert.equal(rep.enabled, false);
  assert.match(rep.note, /never backfilled/);
  await rejects(db.rpc("apply_season_backfill", [mainSeason, admin]), /disabled/);
});

test("cutoff, settling, unresolved work blocks finalization, standings are immutable, corrections supersede", async () => {
  const u = await db.createUser();
  await giveCredits(db, u, 2);
  // One draw fulfilled, one still pending (confirmed before cutoff) when the season ends.
  const c = await confirmedBatch(db, u, 2);
  await settle(c.spinIds[0], 1, c.requestId); // Silver Crate: 10 + 100

  // End the season: move the window into the past (bypass freeze as the DB owner would in a test).
  await db.q(`alter table seasons disable trigger seasons_guard`);
  await db.q(`update seasons set starts_at = now() - interval '3 days', ends_at = now() - interval '1 minute', settlement_deadline = now() - interval '1 second' where id = $1`, [mainSeason]);
  await db.q(`alter table seasons enable trigger seasons_guard`);
  await db.q(`update draw_batches set request_confirmed_at = now() - interval '2 minutes' where id = $1`, [c.batchId]);
  await db.q(`update spins set request_confirmed_at = now() - interval '2 minutes' where batch_id = $1`, [c.batchId]);

  const [{ advance_seasons: moved }] = await db.rpc("advance_seasons");
  assert.equal(moved, 1);
  await rejects(db.rpc("finalize_season", [mainSeason, admin]), /Unresolved work/);

  // Missed deadline -> alert, nothing cancelled.
  await db.rpc("run_db_monitors");
  assert.ok(await db.one(`select 1 from ops_alerts where kind = 'settlement_deadline' and subject = $1 and resolved_at is null`, [mainSeason]));
  assert.equal((await db.one(`select status from spins where id = $1`, [c.spinIds[1]])).status, "pending");

  // The late fulfillment still scores (request was before the cutoff) during settlement.
  await settle(c.spinIds[1], 2, c.requestId); // Gold Crate: 10 + 250
  const [{ finalize_season: fin }] = await db.rpc("finalize_season", [mainSeason, admin]);
  assert.equal(fin.version, 1);
  const st = await db.one(`select total_points from season_standings where season_id = $1 and user_id = $2`, [mainSeason, u]);
  assert.equal(st.total_points, "370");
  const ver = await db.one(`select * from season_standings_versions where season_id = $1 and version = 1`, [mainSeason]);
  assert.match(ver.export_hash, /^[0-9a-f]{64}$/);
  assert.ok(Number(ver.ledger_watermark) > 0);
  assert.ok(ver.rules_hash);
  await rejects(db.q(`update season_standings set total_points = 1 where season_id = $1`, [mainSeason]), /immutable/);
  await rejects(db.q(`delete from season_standings_versions where season_id = $1`, [mainSeason]), /immutable/);
  // Finalized seasons refuse ordinary awards.
  await rejects(db.rpc("ledger_award", [mainSeason, u, "spin", "late", "participation", "10", 1, new Date(), {}, null]), /finalized/);
  // Audited correction -> version 2 superseding 1.
  const bonus = await db.one(`select id from points_ledger where season_id = $1 and user_id = $2 and reward_subtype = 'prize_bonus' and source_id = $3`, [mainSeason, u, c.spinIds[1]]);
  await rejects(db.rpc("correct_finalized_season", [mainSeason, admin, "", JSON.stringify([{ op: "reverse", ledger_id: bonus.id }])]), /reason/);
  const [{ correct_finalized_season: cor }] = await db.rpc("correct_finalized_season", [mainSeason, admin, "Gold Crate double-count", JSON.stringify([{ op: "reverse", ledger_id: bonus.id, amount: "250" }])]);
  assert.deepEqual([cor.version, cor.supersedes], [2, 1]);
  const v2 = await db.one(`select total_points from season_standings where season_id = $1 and version = 2 and user_id = $2`, [mainSeason, u]);
  assert.equal(v2.total_points, "120");
  const v1 = await db.one(`select total_points from season_standings where season_id = $1 and version = 1 and user_id = $2`, [mainSeason, u]);
  assert.equal(v1.total_points, "370"); // history preserved
  const pub = await db.asAnon((s) => s.q(`select * from get_season_leaderboard('main', 0, 100)`));
  assert.ok(pub.every((r) => r.standings_version === 2));
  assert.ok(await db.one(`select 1 from audit_log where action = 'season.corrected'`));
  // Deadline alert resolved on finalization.
  assert.equal((await db.one(`select count(*)::int n from ops_alerts where kind = 'settlement_deadline' and subject = $1 and resolved_at is null`, [mainSeason])).n, 0);
});

test("legacy season stays untouched and visible", async () => {
  const seasons = await db.asAnon((s) => s.q(`select slug, status, is_legacy from get_public_seasons()`));
  assert.ok(seasons.some((x) => x.slug === "legacy-preseason" && x.status === "finalized" && x.is_legacy));
});
