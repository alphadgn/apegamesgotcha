import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, createDb, FIRST_NEW_MIGRATION, migrationFiles } from "./harness";

test("fresh replay: every migration applies in order on an empty database", async () => {
  const db = await createDb({ label: "fresh" });
  try {
    const [{ n }] = await db.sql<
      { n: string }[]
    >`select count(*)::text n from public.seasons where is_legacy`;
    assert.equal(n, "1");
    assert.ok(migrationFiles().includes(FIRST_NEW_MIGRATION));
  } finally {
    await db.drop();
  }
});

test("upgrade: an existing database keeps every point, credit, burn, wallet and admin", async () => {
  const db = await createDb({ label: "upgrade", upTo: FIRST_NEW_MIGRATION });
  const sql = db.sql;
  try {
    // --- data as it exists in production before this change ---
    const [admin] = await sql<
      { id: string }[]
    >`insert into auth.users (email) values ('owner@apegames.test') returning id`;
    const [p1] = await sql<
      { id: string }[]
    >`insert into auth.users (email) values ('player.one@apegames.test') returning id`;
    const [p2] = await sql<
      { id: string }[]
    >`insert into auth.users (email) values ('player.two@apegames.test') returning id`;
    const [orphanless] = [p2!.id];
    const roles =
      await sql`select role from public.user_roles where user_id = ${admin!.id} order by role`;
    assert.ok(
      roles.some((r) => r["role"] === "admin"),
      "old bootstrap made the first user admin",
    );
    await sql`insert into public.wallets (user_id, address, kind, is_default) values (${p1!.id}, ${addr(0xaa)}, 'external', true), (${p1!.id}, ${addr(0xab)}, 'privy', false)`;
    await sql`insert into public.privy_accounts (privy_did, user_id) values ('did:privy:p1', ${p1!.id})`;
    await sql`insert into public.points_ledger (user_id, amount, reason, ref, created_at) values
      (${p1!.id}, 100, 'holding', '12', now() - interval '3 days'),
      (${p1!.id}, 400, 'spin', '7f6c1d4e-0000-0000-0000-000000000001', now() - interval '2 days'),
      (${p1!.id}, -25, 'admin_adjustment', null, now() - interval '1 day'),
      (${orphanless}, 2147483000, 'admin_adjustment', null, now() - interval '1 hour')`;
    const [prize] = await sql<
      { id: string }[]
    >`select id from public.prizes where name = 'Gold Crate'`;
    const [cr] = await sql<
      { id: string }[]
    >`insert into public.spin_credits (user_id, source, ref) values (${p1!.id}, 'burn', '12') returning id`;
    await sql`insert into public.spin_credits (user_id, source, ref) values (${p1!.id}, 'purchase', 'p:1'), (${p1!.id}, 'grant', null)`;
    await sql`insert into public.spins (user_id, credit_id, prize_id, prize_name, rarity, points, roll, total_weight, status)
              values (${p1!.id}, ${cr!.id}, ${prize!.id}, 'Gold Crate', 'epic', 400, 5, 1000, 'fulfilled')`;
    await sql`update public.spin_credits set used_spin_id = (select id from public.spins limit 1) where id = ${cr!.id}`;
    await sql`insert into public.burn_claims (user_id, token_id, tx_hash, level) values (${p1!.id}, '12', ${"0x" + "e".repeat(64)}, 5)`;
    const before = await sql<
      {
        id: string;
        user_id: string;
        amount: number;
        reason: string;
        ref: string | null;
        created_at: Date;
      }[]
    >`select id, user_id, amount, reason, ref, created_at from public.points_ledger order by id`;

    // --- upgrade ---
    await db.applyRemaining(FIRST_NEW_MIGRATION);

    const after = await sql<
      {
        id: string;
        user_id: string;
        amount: string;
        reason: string;
        ref: string | null;
        created_at: Date;
        season_id: string;
        reward_subtype: string;
        effective_at: Date;
      }[]
    >`
      select id, user_id, amount::text, reason, ref, created_at, season_id, reward_subtype, effective_at from public.points_ledger order by id`;
    assert.equal(after.length, before.length);
    const [legacy] = await sql<{ id: string }[]>`select id from public.seasons where is_legacy`;
    for (const [i, b] of before.entries()) {
      const a = after[i]!;
      assert.deepEqual(
        [a.id, a.user_id, Number(a.amount), a.reason, a.ref],
        [b.id, b.user_id, b.amount, b.reason, b.ref],
        "amount/reason/ref unchanged",
      );
      assert.equal(a.season_id, legacy!.id);
      assert.equal(a.reward_subtype, "legacy");
      assert.equal(a.effective_at.getTime(), b.created_at.getTime());
    }
    const totals = await sql<{ user_id: string; total: string; rank: number }[]>`
      select f.user_id, f.total::text, f.rank from public.final_standings f join public.final_standings_versions v on v.id = f.version_id
       where v.season_id = ${legacy!.id} order by f.rank`;
    assert.deepEqual(
      totals.map((t) => [t.user_id, t.total]),
      [
        [p2!.id, "2147483000"],
        [p1!.id, "475"],
      ],
      "not rescaled or reset",
    );

    // Admins kept; no new bootstrap.
    const adminRoles = await sql`select user_id from public.user_roles where role = 'admin'`;
    assert.deepEqual(
      adminRoles.map((r) => r["user_id"]),
      [admin!.id],
    );
    const [later] = await sql<
      { id: string }[]
    >`insert into auth.users (email) values ('newcomer@apegames.test') returning id`;
    assert.equal(
      (await sql`select 1 from public.user_roles where user_id = ${later!.id} and role = 'admin'`)
        .length,
      0,
    );

    // Old email-derived names stay private; nothing public until chosen.
    const [prof] = await sql<
      { display_name: string; public_alias: string | null; public_id: string }[]
    >`select display_name, public_alias, public_id from public.profiles where id = ${p1!.id}`;
    assert.equal(prof!.display_name, "player.one");
    assert.equal(prof!.public_alias, null);
    assert.ok(prof!.public_id);

    // Credits, burns, wallets, Privy links preserved and namespaced.
    const [{ n }] = await sql<
      { n: string }[]
    >`select count(*)::text n from public.spin_credits where user_id = ${p1!.id} and used_spin_id is null`;
    assert.equal(n, "2");
    const [burn] = await sql<
      { chain_id: number; contract: string; level_source: string }[]
    >`select chain_id, contract, level_source from public.burn_claims`;
    assert.deepEqual(
      [burn!.chain_id, burn!.contract, burn!.level_source],
      [33139, "0x8bb7b20291a9fa2f25705b8487194b410808c28b", "legacy"],
    );
    const wallets = await sql<
      { address: string; verification: string; is_default: boolean }[]
    >`select address, verification, is_default from public.wallets order by address`;
    assert.deepEqual(
      wallets.map((w) => w.verification),
      ["legacy_personal_sign", "privy"],
    );
    assert.equal(
      (await sql`select 1 from public.privy_accounts where privy_did = 'did:privy:p1'`).length,
      1,
    );
    const [spin] = await sql<
      { status: string; prize_name: string }[]
    >`select status, prize_name from public.spins`;
    assert.deepEqual([spin!.status, spin!.prize_name], ["fulfilled", "Gold Crate"]);
    // Replaced helpers are gone (no timeout-based refunds remain).
    const gone =
      await sql`select proname from pg_proc where proname in ('begin_spins', 'refund_spins', 'finalize_spin', 'get_leaderboard', 'perform_spin')`;
    assert.equal(gone.length, 0);
    // Legacy prizes keep their stock but are unclassified until an admin verifies them (draws stay paused).
    const problems = await sql`select * from public.prize_catalog_problems()`;
    assert.ok(problems.length >= 4);
    // The candidate collection is seeded without inventing a snapshot block.
    const [col] = await sql<
      { status: string; snapshot_block: string | null }[]
    >`select status, snapshot_block from public.nft_collections`;
    assert.deepEqual([col!.status, col!.snapshot_block], ["candidate", null]);
  } finally {
    await db.drop();
  }
});
