import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, createDb, createUser, rejects, rpc, type Sql } from "./harness";
import {
  ADMIN_ACTOR,
  buySpins,
  CHAIN_ID,
  CONTRACT,
  drawConfirmed,
  enableVrf,
  publishPool,
  settle,
  verifyEconomics,
} from "./fixtures";

async function unused(sql: Sql, u: string) {
  return Number(
    (
      await sql<
        { n: string }[]
      >`select count(*)::text n from public.spin_credits where user_id = ${u} and used_spin_id is null`
    )[0]!.n,
  );
}

test("economics: unknown costs are unverified (never zero); sponsored budgets reserve atomically and pause before exhaustion", async () => {
  const db = await createDb({ label: "econ" });
  const sql = db.sql;
  try {
    const u = await createUser(sql);
    // Fresh catalogue: unclassified prizes and no measured costs.
    const [st] = await rpc<{ economic_status: Record<string, unknown> }>(
      sql,
      "economic_status",
      {},
    );
    assert.equal(st!.economic_status["expected_spin_cost_usd"], null);
    assert.ok((st!.economic_status["catalog_problems"] as unknown[]).length > 0);
    await rejects(
      rpc(sql, "grant_spins", {
        _user_id: u,
        _count: 1,
        _reason: "launch promo",
        _actor: ADMIN_ACTOR,
      }),
      /unverified/,
    );
    const [gate] = await rpc<{ ok: boolean; reason: string }>(sql, "purchase_gate", {
      _quantity: 5,
    });
    assert.deepEqual(
      [gate!.ok, gate!.reason],
      [false, "The prize catalogue has unverified prizes"],
    );

    await verifyEconomics(sql);
    // An unmeasured cost line makes the whole model unverified again.
    await sql`insert into public.operating_costs (category, basis, description) values ('provider', 'per_draw', 'RPC provider per call')`;
    const [st2] = await rpc<{ economic_status: Record<string, unknown> }>(
      sql,
      "economic_status",
      {},
    );
    assert.equal(st2!.economic_status["expected_spin_cost_usd"], null);
    await sql`update public.operating_costs set amount_usd = 0.01, verified_at = now(), evidence = 'invoice' where category = 'provider'`;
    const [cost] = await sql<
      { e: string; w: string }[]
    >`select public.expected_spin_cost_usd()::text e, public.worst_case_spin_cost_usd()::text w`;
    // 100/1000 * 15 + 20/1000 * 300 + 0.28 marginal = 1.5 + 6 + 0.28
    assert.equal(Number(cost!.e), 7.78);
    assert.equal(Number(cost!.w), 300.28);

    await rejects(
      rpc(sql, "grant_spins", {
        _user_id: u,
        _count: 1,
        _reason: "launch promo",
        _actor: ADMIN_ACTOR,
      }),
      /no funded budget/,
    );
    await sql`insert into public.sponsored_budgets (source, name, funded_usd, pause_threshold_usd, evidence) values ('grant', 'Launch promo', 1000, 100, 'sponsor wire 2026-10-01')`;
    // Room for floor((1000-100)/300.28) = 2 grants; a request for 3 is refused entirely.
    await rejects(
      rpc(sql, "grant_spins", {
        _user_id: u,
        _count: 3,
        _reason: "launch promo",
        _actor: ADMIN_ACTOR,
      }),
      /paused/,
    );
    assert.equal(await unused(sql, u), 0, "all-or-nothing");
    await rpc(sql, "grant_spins", {
      _user_id: u,
      _count: 2,
      _reason: "launch promo",
      _actor: ADMIN_ACTOR,
    });
    assert.equal(await unused(sql, u), 2);
    await rejects(
      rpc(sql, "grant_spins", {
        _user_id: u,
        _count: 1,
        _reason: "launch promo",
        _actor: ADMIN_ACTOR,
      }),
      /paused/,
    );
    const alerts = await rpc<{ kind: string }>(sql, "ops_monitor_scan", {});
    assert.ok(alerts.some((a) => a.kind === "budget_exhaustion"));

    // Existing funded credits still draw; settlement records the actual cost against the reservation.
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    const d = await drawConfirmed(sql, u, 1, version);
    const [{ i }] = await sql<
      { i: number }[]
    >`select onchain_index as i from public.prizes where name = 'Banana Chip'`;
    await settle(sql, d.spinIds[0]!, i!, d.requestId);
    const [res] = await sql<
      { status: string; actual_usd: string }[]
    >`select r.status, r.actual_usd::text from public.sponsored_reservations r join public.spins s on s.credit_id = r.credit_id where s.id = ${d.spinIds[0]!}`;
    assert.deepEqual([res!.status, Number(res!.actual_usd)], ["consumed", 0.28]);

    // Purchases need verified reserves for worst-case obligations + owed prizes.
    let [g] = await rpc<{ ok: boolean; reason: string; required_usd: string }>(
      sql,
      "purchase_gate",
      { _quantity: 5 },
    );
    assert.equal(g!.ok, false);
    assert.match(g!.reason, /Reserves/);
    await sql`insert into public.reserve_entries (amount_usd, evidence) values (${Number(g!.required_usd) + 1}, 'segregated reserve wallet statement')`;
    [g] = await rpc(sql, "purchase_gate", { _quantity: 5 });
    assert.equal(g!.ok, true);
    // A new owed real prize raises the requirement.
    const buyer = await createUser(sql);
    await buySpins(sql, buyer, 5);
    [g] = await rpc(sql, "purchase_gate", { _quantity: 5 });
    assert.equal(g!.ok, false, "more outstanding credits → larger worst case");
  } finally {
    await db.drop();
  }
});

test("wallets: SIWE nonces are single-use under concurrency, expire, are domain/chain bound; wallets never move between accounts", async () => {
  const db = await createDb({ label: "siwe" });
  const sql = db.sql;
  try {
    const a = await createUser(sql);
    const b = await createUser(sql);
    const issue = (u: string, nonce: string, wallet: string, ttl = 600) =>
      rpc(sql, "issue_wallet_challenge", {
        _user_id: u,
        _address: wallet,
        _chain_id: 33139,
        _domain: "gotcha.example",
        _uri: "https://gotcha.example/dashboard",
        _nonce: nonce,
        _message: "siwe message",
        _ttl_seconds: ttl,
      });
    const link = (
      u: string,
      nonce: string,
      wallet: string,
      domain = "gotcha.example",
      chain = 33139,
    ) =>
      rpc<{ address: string; is_default: boolean }>(sql, "link_wallet_with_challenge", {
        _user_id: u,
        _nonce: nonce,
        _address: wallet,
        _domain: domain,
        _chain_id: chain,
      });

    await issue(a, "NonceAAAAAAAAAAAAAAA1", addr(0xa1));
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => link(a, "NonceAAAAAAAAAAAAAAA1", addr(0xa1))),
    );
    assert.equal(
      results.filter((r) => r.status === "fulfilled").length,
      1,
      "exactly one concurrent consume wins",
    );
    await rejects(link(a, "NonceAAAAAAAAAAAAAAA1", addr(0xa1)), /expired or was already used/);

    await issue(a, "NonceBBBBBBBBBBBBBBB2", addr(0xa2));
    await rejects(link(b, "NonceBBBBBBBBBBBBBBB2", addr(0xa2)), /expired or was already used/); // other player's nonce
    await issue(a, "NonceCCCCCCCCCCCCCCC3", addr(0xa3));
    await rejects(link(a, "NonceCCCCCCCCCCCCCCC3", addr(0xa3), "evil.example"), /different site/);
    await issue(a, "NonceDDDDDDDDDDDDDDD4", addr(0xa4));
    await rejects(
      link(a, "NonceDDDDDDDDDDDDDDD4", addr(0xa4), "gotcha.example", 1),
      /different chain/,
    );
    await sql`insert into public.wallet_challenges (nonce, user_id, address, chain_id, domain, uri, message, issued_at, expires_at)
              values ('NonceEEEEEEEEEEEEEEE5', ${a}, ${addr(0xa5)}, 33139, 'gotcha.example', 'https://gotcha.example', 'm', now() - interval '20 minutes', now() - interval '10 minutes')`;
    await rejects(link(a, "NonceEEEEEEEEEEEEEEE5", addr(0xa5)), /expired/);
    await rejects(issue(a, "short", addr(0xa6)), /nonce_check|violates check/);

    // Multiple verified wallets per player; the first is default.
    await issue(a, "NonceFFFFFFFFFFFFFFF6", addr(0xa6));
    const [w2] = await link(a, "NonceFFFFFFFFFFFFFFF6", addr(0xa6));
    assert.equal(w2!.is_default, false);
    // Cross-account conflict: B can't take A's wallet, and nothing moves.
    await issue(b, "NonceGGGGGGGGGGGGGGG7", addr(0xa1));
    await rejects(link(b, "NonceGGGGGGGGGGGGGGG7", addr(0xa1)), /another account/);
    await rejects(
      rpc(sql, "link_privy_wallet", { _user_id: b, _address: addr(0xa6), _kind: "external" }),
      /another account/,
    );
    const [owner] = await sql<
      { user_id: string }[]
    >`select user_id from public.wallets where address = ${addr(0xa1)}`;
    assert.equal(owner!.user_id, a);

    // Privy logins: verified links preserved; a login attached to another player is a conflict, never a merge.
    await rpc(sql, "link_privy_account", { _user_id: a, _privy_did: "did:privy:abc123" });
    await rpc(sql, "link_privy_account", { _user_id: a, _privy_did: "did:privy:abc123" });
    await rejects(
      rpc(sql, "link_privy_account", { _user_id: b, _privy_did: "did:privy:abc123" }),
      /another player/,
    );
    // At most 5 live challenges per player (B already has one open from the refused link above).
    for (let i = 0; i < 4; i++) await issue(b, `NonceZZZZZZZZZZZZZZ${i}x`, addr(0xb0 + i));
    await rejects(issue(b, "NonceZZZZZZZZZZZZZZ9x", addr(0xbf)), /Too many/);
  } finally {
    await db.drop();
  }
});
