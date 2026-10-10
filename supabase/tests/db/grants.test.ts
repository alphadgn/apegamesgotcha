import { test } from "node:test";
import assert from "node:assert/strict";
import { asRole, createDb, createUser, rejects, rpc, type Sql } from "./harness";
import {
  ADMIN_ACTOR,
  buySpins,
  CHAIN_ID,
  CONTRACT,
  enableVrf,
  publishPool,
  verifyEconomics,
} from "./fixtures";

async function unused(sql: Sql, u: string, kind: "real" | "demo") {
  const [r] = await sql<{ n: string }[]>`select count(*)::text n from public.spin_credits
    where user_id = ${u} and kind = ${kind} and used_spin_id is null and used_at is null`;
  return Number(r!.n);
}

test("admin grants: demo vs paid-equivalent, tracked, usable at once and exempt from per-player limits", async () => {
  const db = await createDb({ label: "grants" });
  const sql = db.sql;
  try {
    await verifyEconomics(sql);
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    await sql`update public.app_config set value = value || '{"daily_limit": 1}' where key = 'spins'`;
    await sql`insert into public.sponsored_budgets (source, name, funded_usd, pause_threshold_usd, evidence)
              values ('grant', 'Promo', 100000, 0, 'sponsor wire')`;
    const a = await createUser(sql);
    const c = await createUser(sql);

    // Demo grants need no sponsored budget and never become draw liabilities.
    const [before] = await rpc<{ outstanding_spin_count: string }>(
      sql,
      "outstanding_spin_count",
      {},
    );
    await rpc(sql, "grant_spins", {
      _user_id: a,
      _count: 2,
      _reason: "booth demo",
      _actor: ADMIN_ACTOR,
      _kind: "demo",
    });
    const [after] = await rpc<{ outstanding_spin_count: string }>(
      sql,
      "outstanding_spin_count",
      {},
    );
    assert.equal(Number(after!.outstanding_spin_count), Number(before!.outstanding_spin_count));
    await rpc(sql, "grant_spins", {
      _user_id: a,
      _count: 3,
      _reason: "VIP comp",
      _actor: ADMIN_ACTOR,
      _kind: "real",
    });
    await rejects(
      rpc(sql, "grant_spins", {
        _user_id: a,
        _count: 1,
        _reason: "free entry",
        _actor: ADMIN_ACTOR,
        _source: "free_entry",
        _kind: "demo",
      }),
      /only be granted/,
    );
    assert.deepEqual([await unused(sql, a, "real"), await unused(sql, a, "demo")], [3, 2]);

    const grants = await sql<{ kind: string; count: number; note: string }[]>`
      select kind, count, note from public.spin_grants where user_id = ${a} order by created_at, kind`;
    assert.deepEqual(grants.map((g) => [g.kind, g.count, g.note]).sort(), [
      ["demo", 2, "booth demo"],
      ["real", 3, "VIP comp"],
    ]);
    // Only grant_spins writes grant rows: not the server's service role, not browsers.
    for (const role of ["service_role", "authenticated"] as const)
      await rejects(
        asRole(
          sql,
          role,
          a,
          (tx) =>
            tx`insert into public.spin_grants (user_id, kind, count) values (${a}, 'real', 1)`,
        ),
        /permission denied/,
      );

    // Demo spins are used on the demo machine, never by the on-chain draw.
    const [used] = await rpc<{ use_demo_spins: number }>(sql, "use_demo_spins", {
      _user_id: a,
      _count: 5,
    });
    assert.equal(Number(used!.use_demo_spins), 2);
    assert.equal(await unused(sql, a, "demo"), 0);

    const begin = (u: string, key: string, n: number) =>
      rpc<{ spin_ids: string[] }>(sql, "begin_draw_batch", {
        _user_id: u,
        _idempotency_key: key,
        _count: n,
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _pool_version: version,
      }).then((r) => r[0]!);

    // Purchased spins still respect the daily limit (1 here)...
    await buySpins(sql, c, 5);
    await rejects(begin(c, "limit-key-0001", 2), /Daily spin limit/);
    // ...but granted ones don't count: 3 granted + 1 purchased fit under a limit of 1.
    await buySpins(sql, a, 5);
    const batch = await begin(a, "grant-key-0001", 4);
    assert.equal(batch.spin_ids.length, 4);
    const sources = await sql<{ source: string; n: string }[]>`
      select c.source, count(*)::text n from public.spins s join public.spin_credits c on c.id = s.credit_id
       where s.user_id = ${a} group by c.source order by c.source`;
    assert.deepEqual(
      sources.map((r) => [r.source, Number(r.n)]),
      [
        ["grant", 3],
        ["purchase", 1],
      ],
    );
  } finally {
    await db.drop();
  }
});
