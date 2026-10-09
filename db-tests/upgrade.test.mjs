// Upgrade path: a database that already ran every pre-season migration (including the duplicate
// copies Lovable applied) and holds real-looking data, then receives the new forward migrations.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG, createDatabase, applyMigrations, dropDatabase } from "./lib.mjs";

const NAME = "gotcha_upgrade";
const isNew = (f) => f >= "20261009";
let c;

after(async () => {
  await c?.end();
  await dropDatabase(NAME);
});

test("upgrade from the current production schema preserves legacy points", async () => {
  await createDatabase(NAME, { filter: (f) => !isNew(f) });
  c = new pg.Client({ ...PG, database: NAME });
  await c.connect();

  // --- seed data shaped like production -------------------------------------------------------
  const users = [];
  for (const email of ["first@example.com", "second@example.com", "third@example.com"]) {
    const { rows } = await c.query(`insert into auth.users(email) values ($1) returning id`, [email]);
    users.push(rows[0].id);
  }
  // The old trigger made the very first registrant an admin and copied the email into display_name.
  const { rows: admins } = await c.query(`select user_id from user_roles where role = 'admin'`);
  assert.deepEqual(admins.map((r) => r.user_id), [users[0]]);

  const [a, b] = users;
  await c.query(`insert into points_ledger(user_id, amount, reason, ref, created_at) values
    ($1, 100, 'holding', 'token-1', '2026-09-25T10:00:00Z'),
    ($1, 400, 'spin', gen_random_uuid()::text, '2026-09-26T10:00:00Z'),
    ($2, 250, 'holding', 'token-2', '2026-09-25T11:00:00Z'),
    ($2, 250, 'spin', gen_random_uuid()::text, '2026-09-27T09:00:00Z'),
    ($2, -50, 'admin_adjustment', null, '2026-09-28T09:00:00Z')`, [a, b]);
  await c.query(`insert into wallets(user_id, address) values ($1, '0x00000000000000000000000000000000000000a1')`, [a]);
  await c.query(`insert into spin_credits(user_id, source, ref) values ($1, 'grant', null), ($1, 'purchase', 'p:1')`, [a]);
  const before = await c.query(`select id, user_id, amount, reason, ref, created_at from points_ledger order by id`);

  // --- apply the new migrations ------------------------------------------------------------
  await c.end();
  await applyMigrations(NAME, isNew);
  c = new pg.Client({ ...PG, database: NAME });
  await c.connect();

  // Ledger rows: same ids, users, amounts, reasons, refs and timestamps.
  const afterRows = await c.query(`select id, user_id, amount::text as amount, reason, ref, created_at, reward_subtype, source_type from points_ledger order by id`);
  assert.equal(afterRows.rows.length, before.rows.length);
  before.rows.forEach((r, i) => {
    const n = afterRows.rows[i];
    assert.equal(n.id, r.id);
    assert.equal(n.user_id, r.user_id);
    assert.equal(n.amount, String(r.amount));
    assert.equal(n.reason, r.reason);
    assert.equal(n.ref, r.ref);
    assert.equal(n.created_at.toISOString(), r.created_at.toISOString());
    assert.equal(n.source_type, "legacy");
  });

  // Legacy season: finalized, aggregates equal the raw sums, standings v1 with a hash and watermark.
  const { rows: [legacy] } = await c.query(`select * from seasons where slug = 'legacy-preseason'`);
  assert.equal(legacy.status, "finalized");
  assert.equal(legacy.is_legacy, true);
  const { rows: scores } = await c.query(`select user_id, total_points::text t, nft_points::text n, prize_points::text p, adjustment_points::text adj from season_scores where season_id = $1 order by total_points desc`, [legacy.id]);
  assert.deepEqual(scores.map((s) => [s.user_id, s.t, s.n, s.p, s.adj]), [
    [a, "500", "100", "400", "0"],
    [b, "450", "250", "250", "-50"],
  ]);
  const { rows: [ver] } = await c.query(`select * from season_standings_versions where season_id = $1`, [legacy.id]);
  assert.equal(ver.version, 1);
  assert.match(ver.export_hash, /^[0-9a-f]{64}$/);
  assert.equal(String(ver.ledger_watermark), String(before.rows.at(-1).id));
  const { rows: standings } = await c.query(`select rank::int, user_id, total_points::text t from season_standings where season_id = $1 order by rank`, [legacy.id]);
  assert.deepEqual(standings.map((s) => [s.rank, s.user_id, s.t]), [[1, a, "500"], [2, b, "450"]]);

  // Legacy rows can't be edited or deleted, and the finalized legacy season takes no new awards.
  await assert.rejects(c.query(`update points_ledger set amount = 1 where id = $1`, [before.rows[0].id]), /append-only/);
  await assert.rejects(c.query(`delete from points_ledger where id = $1`, [before.rows[0].id]), /append-only/);
  await assert.rejects(
    c.query(`select ledger_award($1, $2, 'adjustment', 'x', 'adjustment', 5, null, now(), '{}'::jsonb, null)`, [legacy.id, a]),
    /finalized/,
  );

  // Existing admin kept; new registrants never become admin; emails are not copied into names.
  const { rows: [newUser] } = await c.query(`insert into auth.users(email) values ('fourth@example.com') returning id`);
  const { rows: adminsAfter } = await c.query(`select user_id from user_roles where role = 'admin'`);
  assert.deepEqual(adminsAfter.map((r) => r.user_id), [users[0]]);
  const { rows: [prof] } = await c.query(`select display_name, public_id, public_alias from profiles where id = $1`, [newUser.id]);
  assert.equal(prof.display_name, null);
  assert.equal(prof.public_alias, null);
  assert.match(prof.public_id, /^ape_[0-9a-f]{12}$/);

  // Every existing profile received an opaque public id.
  const { rows: [{ missing }] } = await c.query(`select count(*)::int missing from profiles where public_id is null`);
  assert.equal(missing, 0);

  // Existing wallets and credits survive.
  const { rows: [{ n: walletCount }] } = await c.query(`select count(*)::int n from wallets`);
  assert.equal(walletCount, 1);
  const { rows: [{ n: creditCount }] } = await c.query(`select count(*)::int n from spin_credits`);
  assert.equal(creditCount, 2);
});

test("fresh replay of every migration succeeds and is consistent", async () => {
  await createDatabase("gotcha_fresh");
  const f = new pg.Client({ ...PG, database: "gotcha_fresh" });
  await f.connect();
  try {
    const { rows: [legacy] } = await f.query(`select status from seasons where slug = 'legacy-preseason'`);
    assert.equal(legacy.status, "finalized");
    const { rows: [{ n }] } = await f.query(`select count(*)::int n from season_standings_versions`);
    assert.equal(n, 1);
  } finally {
    await f.end();
    await dropDatabase("gotcha_fresh");
  }
});
