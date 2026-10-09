// Ledger, aggregates, reversals and ranking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin, activeSeason } from "./fixtures.mjs";

let db, admin, season;
before(async () => {
  db = await freshDb("ledger");
  await cleanPool(db);
  admin = await makeAdmin(db);
  season = await activeSeason(db, admin);
});
after(async () => db?.close());

const award = (user, src, sub, amt, at = new Date()) =>
  db.rpc("ledger_award", [season, user, "spin", src, sub, amt, 1, at, {}, null]).then((r) => r[0].ledger_award);
const score = (user) => db.one(`select * from season_scores where season_id = $1 and user_id = $2`, [season, user]);

test("an award is recorded once; duplicates do not increment totals", async () => {
  const u = await db.createUser();
  const first = await award(u, "spin-a", "participation", "10");
  const dup = await award(u, "spin-a", "participation", "10");
  assert.ok(first);
  assert.equal(dup, null);
  const s = await score(u);
  assert.equal(s.total_points, "10");
  assert.equal(s.participation_points, "10");
});

test("participation and prize bonus are separate entries", async () => {
  const u = await db.createUser();
  await award(u, "spin-b", "participation", "10");
  await award(u, "spin-b", "prize_bonus", "25");
  const rows = await db.q(`select reward_subtype, amount from points_ledger where user_id = $1 order by id`, [u]);
  assert.deepEqual(rows.map((r) => [r.reward_subtype, r.amount]), [["participation", "10"], ["prize_bonus", "25"]]);
  const s = await score(u);
  assert.equal(s.prize_points, "25");
  assert.equal(s.total_points, "35");
});

test("concurrent duplicate awards insert exactly one row", async () => {
  const u = await db.createUser();
  const results = await Promise.all(Array.from({ length: 8 }, () => award(u, "spin-race", "participation", "10")));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await score(u)).total_points, "10");
});

test("bigint-safe totals beyond 2^53", async () => {
  const u = await db.createUser();
  await award(u, "big-1", "participation", "9007199254740993");
  await award(u, "big-2", "participation", "10");
  assert.equal((await score(u)).total_points, "9007199254741003");
});

test("ledger is append-only in Postgres (update, delete, truncate)", async () => {
  const u = await db.createUser();
  const id = await award(u, "spin-c", "participation", "10");
  await rejects(db.q(`update points_ledger set amount = 99 where id = $1`, [id]), /append-only/);
  await rejects(db.q(`delete from points_ledger where id = $1`, [id]), /append-only/);
  await rejects(db.q(`truncate points_ledger`), /append-only/);
  await rejects(db.asService((s) => s.q(`update points_ledger set amount = 99 where id = $1`, [id])), /append-only/);
});

test("aggregates cannot be written directly, even by the service role", async () => {
  const u = await db.createUser();
  await award(u, "spin-d", "participation", "10");
  await rejects(
    db.asService((s) => s.q(`update season_scores set total_points = 999, participation_points = 999 where user_id = $1`, [u])),
    /maintained by the ledger/,
  );
});

test("reversals: reason required, opposite sign, never more than remains", async () => {
  const u = await db.createUser();
  const id = await award(u, "spin-e", "prize_bonus", "100");
  await rejects(db.rpc("reverse_ledger_entry", [id, "10", "", admin]), /reason/);
  await rejects(db.rpc("reverse_ledger_entry", [id, "10", "ok reason", u]), /Forbidden/);
  await db.rpc("reverse_ledger_entry", [id, "60", "duplicate payout", admin]);
  assert.equal((await score(u)).total_points, "40");
  await rejects(db.rpc("reverse_ledger_entry", [id, "41", "too much", admin]), /at most 40/);
  await db.rpc("reverse_ledger_entry", [id, null, "rest of it", admin]);
  assert.equal((await score(u)).total_points, "0");
  await rejects(db.rpc("reverse_ledger_entry", [id, null, "again", admin]), /Nothing left/);
  // A reversal row cannot be the target of another reversal.
  const rev = await db.one(`select id from points_ledger where reverses_id = $1 limit 1`, [id]);
  await rejects(db.rpc("reverse_ledger_entry", [rev.id, null, "nested", admin]), /original award/);
  // Direct inserts are checked by the trigger too.
  await rejects(
    db.q(`insert into points_ledger(user_id, amount, reason, season_id, source_type, source_id, reward_subtype, reverses_id, reversal_reason, created_by)
          values ($1, -1, 'x', $2, 'spin', 'spin-e', 'prize_bonus', $3, 'sneaky', $4)`, [u, season, id, admin]),
    /exceeds/,
  );
});

test("concurrent reversals cannot over-reverse", async () => {
  const u = await db.createUser();
  const id = await award(u, "spin-f", "prize_bonus", "100");
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => db.rpc("reverse_ledger_entry", [id, "30", "race", admin])));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await score(u)).total_points, "10");
});

test("tie timestamp: time the current total was reached; full reversal falls back", async () => {
  const u = await db.createUser();
  const t1 = new Date("2026-10-09T01:00:00Z");
  const t2 = new Date("2026-10-09T02:00:00Z");
  await award(u, "tie-1", "participation", "100", t1);
  const late = await award(u, "tie-2", "participation", "50", t2);
  assert.equal((await score(u)).total_reached_at.toISOString(), t2.toISOString());
  await db.rpc("reverse_ledger_entry", [late, null, "fraud", admin]);
  const s = await score(u);
  assert.equal(s.total_points, "100");
  assert.equal(s.total_reached_at.toISOString(), t1.toISOString());
  // Partial reversal keeps the entry contributing at its own time.
  const t3 = new Date("2026-10-09T03:00:00Z");
  const third = await award(u, "tie-3", "participation", "20", t3);
  await db.rpc("reverse_ledger_entry", [third, "5", "partial", admin]);
  assert.equal((await score(u)).total_reached_at.toISOString(), t3.toISOString());
});

test("ranking: total desc, reached-at asc, user id asc, consecutive ordinals", async () => {
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await db.createUser());
  const at = (h) => new Date(Date.UTC(2026, 9, 9, h));
  const aw = (u, src, amt, t) => db.rpc("ledger_award", [season, u, "spin", src, "participation", amt, 1, t, {}, null]);
  await aw(users[0], "r1", "777000", at(3));
  await aw(users[1], "r2", "777000", at(1)); // same total, reached earlier -> ahead
  await aw(users[2], "r3", "888000", at(5));
  await aw(users[3], "r4", "777000", at(1)); // same total and time as users[1] -> user id decides
  const all = await db.q(`select rank::int, user_id from season_ranking($1)`, [season]);
  assert.deepEqual(all.map((r) => r.rank), all.map((_, i) => i + 1)); // 1..n, no gaps or shared places
  const mine = all.filter((r) => users.includes(r.user_id)).map((r) => r.user_id);
  const tie = [users[1], users[3]].sort();
  assert.deepEqual(mine, [users[2], ...tie, users[0]]);
});

test("zero-point and legacy-subtype entries are refused", async () => {
  const u = await db.createUser();
  assert.equal(await award(u, "zero", "participation", "0"), null);
  await rejects(
    db.q(`insert into points_ledger(user_id, amount, reason, season_id, source_type, source_id, reward_subtype) values ($1, 5, 'x', $2, 'legacy', 'z', 'legacy_spin')`, [u, season]),
    /archive-only/,
  );
});
