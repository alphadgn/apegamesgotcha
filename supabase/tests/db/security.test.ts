import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { asRole, createDb, createUser, makeAdmin, rejects, rpc, addr, type Sql } from "./harness";
import { activeSeason, ADMIN_ACTOR, buySpins } from "./fixtures";

let db: Awaited<ReturnType<typeof createDb>>;
let sql: Sql;

before(async () => {
  db = await createDb({ label: "security" });
  sql = db.sql;
});
after(async () => db?.drop());

const PUBLIC_READ_RPCS = new Set(["list_seasons", "get_season_leaderboard", "get_season_rules"]);
const AUTHENTICATED_RPCS = new Set([...PUBLIC_READ_RPCS, "get_my_season_standing", "has_role"]);

test("only read-only RPCs are executable by anon/authenticated; everything else is service-role only", async () => {
  const rows = await sql<{ proname: string; anon: boolean; authed: boolean }[]>`
    select p.proname,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authed
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'`;
  const anonBad = rows
    .filter((r) => r.anon && !PUBLIC_READ_RPCS.has(r.proname))
    .map((r) => r.proname);
  const authBad = rows
    .filter((r) => r.authed && !AUTHENTICATED_RPCS.has(r.proname))
    .map((r) => r.proname);
  assert.deepEqual(anonBad, [], `anon can execute: ${anonBad.join(", ")}`);
  assert.deepEqual(authBad, [], `authenticated can execute: ${authBad.join(", ")}`);
});

test("every SECURITY DEFINER function pins an empty search_path", async () => {
  const rows = await sql<{ proname: string; cfg: string[] | null }[]>`
    select p.proname, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef`;
  const loose = rows
    .filter((r) => !(r.cfg ?? []).some((c) => c === 'search_path=""' || c === "search_path=''"))
    .map((r) => r.proname);
  assert.deepEqual(loose, []);
});

test("browsers cannot write tables directly (no insert/update/delete for anon or authenticated, except own guide messages)", async () => {
  const rows = await sql<{ t: string; role: string; priv: string }[]>`
    select c.relname as t, r.rolname as role, p.priv
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) r(rolname)
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
     where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, p.priv)`;
  const allowed = rows.filter(
    (r) => !(r.t === "guide_messages" && r.role === "authenticated" && r.priv === "INSERT"),
  );
  assert.deepEqual(allowed, []);
});

test("unauthorized RPC calls fail for anon and authenticated players", async () => {
  const uid = await createUser(sql);
  for (const role of ["anon", "authenticated"] as const) {
    await rejects(
      rpc(
        sql,
        "adjust_points",
        { _season_id: uid, _user_id: uid, _amount: 1000, _reason: "steal points", _actor: uid },
        { role, uid },
      ),
      /permission denied/,
    );
    await rejects(
      rpc(
        sql,
        "grant_spins",
        { _user_id: uid, _count: 5, _reason: "free stuff", _actor: uid },
        { role, uid },
      ),
      /permission denied/,
    );
    await rejects(
      rpc(
        sql,
        "settle_spin",
        {
          _spin_id: uid,
          _chain_status: 2,
          _prize_index: 0,
          _random_word: "1",
          _request_id: "1",
          _evidence: {},
        },
        { role, uid },
      ),
      /permission denied/,
    );
    await rejects(
      rpc(
        sql,
        "link_wallet_with_challenge",
        { _user_id: uid, _nonce: "x".repeat(16), _address: addr(1), _domain: "a", _chain_id: 1 },
        { role, uid },
      ),
      /permission denied/,
    );
  }
  await rejects(
    asRole(
      sql,
      "authenticated",
      uid,
      (tx) =>
        tx`insert into public.points_ledger (user_id, amount, reason) values (${uid}, 999, 'hack')`,
    ),
    /permission denied/,
  );
  await rejects(
    asRole(
      sql,
      "authenticated",
      uid,
      (tx) => tx`insert into public.spin_credits (user_id, source) values (${uid}, 'grant')`,
    ),
    /permission denied/,
  );
  await rejects(
    asRole(
      sql,
      "authenticated",
      uid,
      (tx) => tx`update public.profiles set public_alias = 'Hacker' where id = ${uid}`,
    ),
    /permission denied/,
  );
  await rejects(
    asRole(
      sql,
      "authenticated",
      uid,
      (tx) => tx`insert into public.user_roles (user_id, role) values (${uid}, 'admin')`,
    ),
    /permission denied/,
  );
});

test("no first-registrant admin; profiles never derive a public name from the email", async () => {
  const fresh = await createDb({ label: "noadmin" });
  try {
    const first = await createUser(fresh.sql, "firstperson@example.test");
    const roles = await fresh.sql`select role from public.user_roles where user_id = ${first}`;
    assert.deepEqual(
      roles.map((r) => r["role"]),
      ["user"],
    );
    const [p] =
      await fresh.sql`select display_name, public_alias from public.profiles where id = ${first}`;
    assert.equal(p!["display_name"], null);
    assert.equal(p!["public_alias"], null);
  } finally {
    await fresh.drop();
  }
});

test("private data is visible only to its owner (RLS)", async () => {
  const a = await createUser(sql);
  const b = await createUser(sql);
  await buySpins(sql, a, 5);
  await sql`insert into public.wallets (user_id, address, kind, verification) values (${a}, ${addr(0xa1)}, 'external', 'siwe')`;
  const seenByB = await asRole(sql, "authenticated", b, async (tx) => ({
    wallets: await tx`select * from public.wallets where user_id = ${a}`,
    credits: await tx`select * from public.spin_credits where user_id = ${a}`,
    ledger: await tx`select * from public.points_ledger where user_id = ${a}`,
    purchases: await tx`select * from public.spin_purchases where user_id = ${a}`,
    profiles: await tx`select * from public.profiles where id = ${a}`,
    seasons: await tx`select * from public.seasons`,
    budgets: await tx`select * from public.sponsored_budgets`,
  }));
  for (const [k, rows] of Object.entries(seenByB))
    assert.equal(rows.length, 0, `${k} leaked to another player`);
  await rejects(
    asRole(sql, "authenticated", b, (tx) => tx`select * from public.wallet_challenges`),
    /permission denied/,
  );
  await rejects(
    asRole(sql, "authenticated", b, (tx) => tx`select * from public.draw_submissions`),
    /permission denied/,
  );
  const own = await asRole(
    sql,
    "authenticated",
    a,
    (tx) => tx`select * from public.spin_credits where user_id = ${a}`,
  );
  assert.equal(own.length, 5);
  const anonPrizes = await asRole(sql, "anon", undefined, (tx) => tx`select id from public.prizes`);
  assert.ok(anonPrizes.length > 0);
  await rejects(
    asRole(sql, "anon", undefined, (tx) => tx`select * from public.app_config`),
    /permission denied/,
  );
  // An ordinary player cannot read the vrf config (this is why the machine uses a readiness endpoint).
  const vrf = await asRole(
    sql,
    "authenticated",
    a,
    (tx) => tx`select * from public.app_config where key = 'vrf'`,
  );
  assert.equal(vrf.length, 0);
});

test("public standings expose only alias/avatar, opaque id and scores", async () => {
  const s = await activeSeason(sql, { slug: "pubcheck" });
  const u = await createUser(sql, "secret.person@example.test", { full_name: "Secret Person" });
  await rpc(sql, "adjust_points", {
    _season_id: s.id,
    _user_id: u,
    _amount: 5,
    _reason: "test adjustment",
    _actor: ADMIN_ACTOR,
  });
  const rows = await rpc<Record<string, unknown>>(
    sql,
    "get_season_leaderboard",
    { _season_id: s.id, _limit: 10, _offset: 0 },
    { role: "anon" },
  );
  assert.equal(rows.length, 1);
  const cols = Object.keys(rows[0]!).sort();
  assert.deepEqual(
    cols,
    [
      "adjustment_points",
      "alias",
      "avatar_key",
      "is_final",
      "legacy_points",
      "nft_points",
      "participation_points",
      "prize_points",
      "public_id",
      "rank",
      "social_points",
      "standings_version",
      "total_count",
      "total_points",
    ].sort(),
  );
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(u), "auth id leaked");
  assert.ok(!text.includes("secret.person"), "email leaked");
  assert.ok(!text.includes("Secret Person"), "private display name leaked");
  assert.equal(rows[0]!["alias"], null);
  await rpc(sql, "set_public_profile", { _user_id: u, _alias: "BananaKing", _avatar_key: "ape-3" });
  const [after] = await rpc<Record<string, unknown>>(
    sql,
    "get_season_leaderboard",
    { _season_id: s.id, _limit: 10, _offset: 0 },
    { role: "anon" },
  );
  assert.equal(after!["alias"], "BananaKing");
  const other = await createUser(sql);
  await rejects(
    rpc(sql, "set_public_profile", { _user_id: other, _alias: "bananaking", _avatar_key: null }),
    /taken/,
  );
  await rejects(
    rpc(sql, "set_public_profile", { _user_id: other, _alias: "=HYPERLINK()", _avatar_key: null }),
    /Alias must be/,
  );
  // Draft seasons are not public.
  const [d] = await rpc<{ id: string }>(sql, "create_season_draft", {
    _slug: "secret-draft",
    _name: "Draft",
    _starts_at: null,
    _ends_at: null,
    _settlement_deadline: null,
    _rules: {},
    _notes: null,
    _actor: ADMIN_ACTOR,
  });
  const listed = await rpc<{ id: string }>(sql, "list_seasons", {}, { role: "anon" });
  assert.ok(!listed.some((x) => x.id === d!.id));
  await rejects(
    rpc(
      sql,
      "get_season_leaderboard",
      { _season_id: d!.id, _limit: 10, _offset: 0 },
      { role: "anon" },
    ),
    /Unknown season/,
  );
});

test("a player's own standing needs a session and returns only their row", async () => {
  const s = await activeSeason(sql, {
    slug: "mystanding",
    startOffsetSec: -60,
    endOffsetSec: 3600,
  }).catch(async () => {
    // another test's season may be active; reuse it
    const [x] = await sql<{ id: string }[]>`select id from public.seasons where status = 'active'`;
    return x as { id: string };
  });
  const me = await createUser(sql);
  await rpc(sql, "adjust_points", {
    _season_id: s.id,
    _user_id: me,
    _amount: 7,
    _reason: "test adjustment",
    _actor: ADMIN_ACTOR,
  });
  await rejects(
    rpc(sql, "get_my_season_standing", { _season_id: s.id }, { role: "anon" }),
    /permission denied/,
  );
  const [mine] = await rpc<{ total_points: string; rank: string }>(
    sql,
    "get_my_season_standing",
    { _season_id: s.id },
    { role: "authenticated", uid: me },
  );
  assert.equal(mine!.total_points, "7");
});

test("admin role is checked from the database, and admins can read but not write through the API", async () => {
  const adm = await createUser(sql);
  await makeAdmin(sql, adm);
  const [r] = await rpc<{ has_role: boolean }>(
    sql,
    "has_role",
    { _user_id: adm, _role: "admin" },
    { role: "authenticated", uid: adm },
  );
  assert.equal(r!.has_role, true);
  await rejects(
    asRole(
      sql,
      "authenticated",
      adm,
      (tx) => tx`update public.app_config set value = '{}' where key = 'vrf'`,
    ),
    /permission denied/,
  );
});
