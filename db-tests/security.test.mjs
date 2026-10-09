// Privileges, RLS and private-data isolation, exercised as the real PostgREST roles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin, activeSeason, giveCredits, confirmedBatch, hex } from "./fixtures.mjs";

let db, admin, season, alice, bob;
before(async () => {
  db = await freshDb("security");
  await cleanPool(db);
  admin = await makeAdmin(db);
  season = await activeSeason(db, admin);
  alice = await db.createUser("alice@example.com");
  bob = await db.createUser("bob@example.com");
  await db.rpc("link_verified_wallet", [alice, "0x" + "1".repeat(40), "external", "siwe", 1, false]);
  await db.rpc("link_verified_wallet", [bob, "0x" + "2".repeat(40), "external", "siwe", 1, false]);
  await giveCredits(db, alice, 1);
  const c = await confirmedBatch(db, alice, 1);
  await db.rpc("settle_drawn_spin", [c.spinIds[0], 3, "1", c.requestId, 200, hex()]); // real prize -> fulfillment row
  await db.rpc("link_x_account", [alice, "alice_x", null, "manual"]);
});
after(async () => db?.close());

test("only read-only public RPCs are executable by anon/authenticated", async () => {
  const rows = await db.q(`
    select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'`);
  const anon = rows.filter((r) => r.anon).map((r) => r.proname).sort();
  const auth = rows.filter((r) => r.auth).map((r) => r.proname).sort();
  assert.deepEqual(anon, ["get_leaderboard", "get_public_seasons", "get_season_leaderboard", "is_admin"]);
  assert.deepEqual(auth, ["get_leaderboard", "get_my_season_standing", "get_public_seasons", "get_season_leaderboard", "is_admin"]);
});

test("every SECURITY DEFINER function pins search_path", async () => {
  const rows = await db.q(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(rows, []);
});

test("RLS is enabled on every public table; clients cannot write any game table", async () => {
  const noRls = await db.q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls, []);
  const writable = await db.q(`
    select c.relname, r.rolname, p.priv
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) r(rolname)
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
     where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, p.priv)`);
  // The guide chat inserts its own messages (RLS-checked); nothing else is client-writable.
  assert.deepEqual(writable.map((w) => `${w.relname}:${w.rolname}:${w.priv}`), ["guide_messages:authenticated:INSERT"]);
});

test("players cannot call mutating RPCs or has_role", async () => {
  await rejects(db.asUser(alice, (s) => s.q(`select ledger_award($1, $2, 'adjustment', 'x', 'adjustment', 1000, null, now(), '{}', null)`, [season, alice])), /permission denied/);
  await rejects(db.asUser(alice, (s) => s.q(`select has_role($1, 'admin')`, [alice])), /permission denied/);
  await rejects(db.asUser(alice, (s) => s.q(`select reserve_draw_batch($1, 1, 'kkkkkkkkkk', 1, $2, 1)`, [alice, "0x" + "c".repeat(40)])), /permission denied/);
  await rejects(db.asUser(alice, (s) => s.q(`select finalize_season($1, $2)`, [season, alice])), /permission denied/);
  await rejects(db.asAnon((s) => s.q(`select set_public_profile($1, 'hax', null)`, [alice])), /permission denied/);
  await rejects(db.asUser(alice, (s) => s.q(`insert into points_ledger(user_id, amount, reason, season_id, source_type, source_id, reward_subtype) values ($1, 1, 'x', $2, 'a', 'b', 'adjustment')`, [alice, season])), /permission denied/);
  await rejects(db.asUser(alice, (s) => s.q(`update profiles set public_id = 'ape_hacked' where id = $1`, [alice])), /permission denied/);
});

test("a player only sees their own private rows", async () => {
  const tables = ["wallets", "points_ledger", "spins", "spin_credits", "season_scores", "x_accounts", "prize_fulfillments", "draw_batches", "profiles"];
  for (const t of tables) {
    const col = t === "profiles" ? "id" : "user_id";
    const asBob = await db.asUser(bob, (s) => s.q(`select ${col} as owner from ${t}`));
    assert.ok(asBob.every((r) => r.owner === bob), `${t} leaked to another player`);
    const asAlice = await db.asUser(alice, (s) => s.q(`select ${col} as owner from ${t}`));
    assert.ok(asAlice.length > 0 && asAlice.every((r) => r.owner === alice), `${t} should show alice her own rows`);
  }
});

test("anon cannot read private tables; operational tables are admin-only", async () => {
  for (const t of ["wallets", "points_ledger", "spins", "profiles", "app_config", "season_scores", "audit_log"]) {
    await rejects(db.asAnon((s) => s.q(`select * from ${t} limit 1`)), /permission denied/);
  }
  for (const t of ["audit_log", "ops_alerts", "operating_costs", "funding_events", "draw_submissions", "draw_coordination", "prize_pool_publications"]) {
    const rows = await db.asUser(alice, (s) => s.q(`select * from ${t}`));
    assert.equal(rows.length, 0, `${t} must be empty for non-admins`);
  }
  const adminSees = await db.asUser(admin, (s) => s.q(`select * from draw_submissions`));
  assert.ok(adminSees.length > 0);
});

test("app_config: players see only the nft key (never vrf/purchase internals)", async () => {
  const keys = (await db.asUser(alice, (s) => s.q(`select key from app_config`))).map((r) => r.key);
  assert.deepEqual(keys, ["nft"]);
});

test("prize costs are not visible to clients", async () => {
  await rejects(db.asUser(alice, (s) => s.q(`select unit_cost_usd from prizes`)), /permission denied/);
  const rows = await db.asAnon((s) => s.q(`select id, name, rarity, weight, inventory, kind from prizes`));
  assert.ok(rows.length >= 4);
});

test("wallet challenges and nonces are invisible to clients", async () => {
  await rejects(db.asUser(alice, (s) => s.q(`select * from wallet_challenges`)), /permission denied/);
});

test("new sign-ups never become admin; is_admin reflects the signed-in user only", async () => {
  const carol = await db.createUser("carol@example.com");
  assert.equal(await db.asUser(carol, (s) => s.one(`select is_admin() v`)).then((r) => r.v), false);
  assert.equal(await db.asUser(admin, (s) => s.one(`select is_admin() v`)).then((r) => r.v), true);
  assert.equal(await db.asAnon((s) => s.one(`select is_admin() v`)).then((r) => r.v), false);
});
