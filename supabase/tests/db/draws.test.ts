import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, createDb, createUser, rejects, rpc, type Sql } from "./harness";
import {
  activeSeason,
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

async function idx(sql: Sql, name: string) {
  const [r] = await sql<
    { i: number }[]
  >`select onchain_index as i from public.prizes where name = ${name}`;
  return r!.i;
}
async function credits(sql: Sql, u: string) {
  const [r] = await sql<
    { n: string }[]
  >`select count(*)::text as n from public.spin_credits where user_id = ${u} and used_spin_id is null`;
  return Number(r!.n);
}
async function ledgerFor(sql: Sql, spinId: string) {
  return sql<
    { reward_subtype: string; amount: string }[]
  >`select reward_subtype, amount::text from public.points_ledger where source_type = 'spin' and source_id = ${spinId} order by reward_subtype`;
}

async function world(label: string) {
  const db = await createDb({ label });
  const sql = db.sql;
  await verifyEconomics(sql);
  await enableVrf(sql);
  const { version } = await publishPool(sql);
  return { db, sql, version };
}

test("reservation: idempotency, global serialisation, rolling daily limit with pending reservations, refund exactly once", async () => {
  const { db, sql, version } = await world("reserve");
  try {
    await sql`update public.app_config set value = value || '{"daily_limit": 3}' where key = 'spins'`;
    const a = await createUser(sql);
    const b = await createUser(sql);
    await buySpins(sql, a, 10);
    await buySpins(sql, b, 5);
    const begin = (u: string, key: string, n = 1, pv = version) =>
      rpc<{ id: string; spin_ids: string[]; status: string; season_id: string | null }>(
        sql,
        "begin_draw_batch",
        {
          _user_id: u,
          _idempotency_key: key,
          _count: n,
          _chain_id: CHAIN_ID,
          _contract: CONTRACT,
          _pool_version: pv,
        },
      ).then((r) => r[0]!);

    const first = await begin(a, "idem-key-0001", 2);
    const again = await begin(a, "idem-key-0001", 2);
    assert.equal(again.id, first.id, "same key → same batch");
    assert.equal(await credits(sql, a), 8, "credits reserved once");
    await rejects(begin(a, "idem-key-0001", 3), /different request/);
    await rejects(begin(b, "other-player-1"), /finishing another draw/);
    // Concurrent retries of the same request never double-reserve.
    await rpc(sql, "refund_batch_prebroadcast", { _batch_id: first.id, _reason: "test" });
    const twin = await Promise.all([begin(a, "idem-key-0002", 1), begin(a, "idem-key-0002", 1)]);
    assert.equal(twin[0].id, twin[1].id);
    assert.equal(await credits(sql, a), 9);

    // Refund only before anything was signed, and exactly once.
    await rpc(sql, "refund_batch_prebroadcast", {
      _batch_id: twin[0].id,
      _reason: "simulate signing failure",
    });
    await rpc(sql, "refund_batch_prebroadcast", { _batch_id: twin[0].id, _reason: "again" });
    assert.equal(await credits(sql, a), 10, "capacity and credit released exactly once");

    // Daily limit counts pending reservations (3/day here).
    const d1 = await drawConfirmed(sql, a, 2, version);
    await rejects(begin(a, "over-the-limit", 2), /Daily spin limit/);
    const d2 = await begin(a, "within-limit", 1);
    assert.equal(d2.spin_ids.length, 1);
    await rpc(sql, "refund_batch_prebroadcast", { _batch_id: d2.id, _reason: "test" });
    assert.equal(d1.spinIds.length, 2);

    // Signed means maybe broadcast: no refund without on-chain proof.
    await rpc(sql, "settle_spin", {
      _spin_id: d1.spinIds[0],
      _chain_status: 2,
      _prize_index: await idx(sql, "Banana Chip"),
      _random_word: "1",
      _request_id: d1.requestId,
      _evidence: {},
    });
    await rpc(sql, "settle_spin", {
      _spin_id: d1.spinIds[1],
      _chain_status: 2,
      _prize_index: await idx(sql, "Banana Chip"),
      _random_word: "2",
      _request_id: d1.requestId,
      _evidence: {},
    });
    const s = await begin(b, "signed-batch-1");
    await rpc(sql, "record_signed_submission", {
      _batch_id: s.id,
      _chain_id: CHAIN_ID,
      _operator: addr(0x0b),
      _nonce: 900,
      _tx_hash: `0x${"5".repeat(64)}`,
      _raw_tx: "0x02f801",
    });
    await rejects(
      rpc(sql, "refund_batch_prebroadcast", { _batch_id: s.id, _reason: "timeout" }),
      /on-chain proof/,
    );
    // Broadcast failed with a network error: still reserved, same signed tx kept for resending.
    await rpc(sql, "mark_submission_broadcast", {
      _tx_hash: `0x${"5".repeat(64)}`,
      _error: "fetch failed",
    });
    const [sub] = await sql<
      { status: string; raw_tx: string; broadcast_attempts: number }[]
    >`select status, raw_tx, broadcast_attempts from public.draw_submissions where tx_hash = ${"0x" + "5".repeat(64)}`;
    assert.deepEqual(
      [sub!.status, sub!.raw_tx, sub!.broadcast_attempts],
      ["signed", "0x02f801", 1],
    );
    // A replacement must reuse the nonce; another batch can't take it.
    await rejects(
      rpc(sql, "record_signed_submission", {
        _batch_id: s.id,
        _chain_id: CHAIN_ID,
        _operator: addr(0x0b),
        _nonce: 901,
        _tx_hash: `0x${"6".repeat(64)}`,
        _raw_tx: "0x02f802",
      }),
      /reuse the original nonce/,
    );
    await rpc(sql, "record_signed_submission", {
      _batch_id: s.id,
      _chain_id: CHAIN_ID,
      _operator: addr(0x0b),
      _nonce: 900,
      _tx_hash: `0x${"7".repeat(64)}`,
      _raw_tx: "0x02f803",
    });
    // Receipt seen with too few confirmations: nothing changes yet.
    await rpc(sql, "record_request_receipt", {
      _tx_hash: `0x${"7".repeat(64)}`,
      _success: false,
      _block_number: 10,
      _block_hash: `0x${"a".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 1,
      _min_confirmations: 3,
      _request_id: null,
      _spin_ids: [],
    });
    assert.equal(await credits(sql, b), 4);
    // Canonically confirmed revert: credits come back once.
    await rpc(sql, "record_request_receipt", {
      _tx_hash: `0x${"7".repeat(64)}`,
      _success: false,
      _block_number: 10,
      _block_hash: `0x${"a".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 4,
      _min_confirmations: 3,
      _request_id: null,
      _spin_ids: [],
    });
    await rpc(sql, "record_request_receipt", {
      _tx_hash: `0x${"7".repeat(64)}`,
      _success: false,
      _block_number: 10,
      _block_hash: `0x${"a".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 9,
      _min_confirmations: 3,
      _request_id: null,
      _spin_ids: [],
    });
    assert.equal(await credits(sql, b), 5);
    const [bs] = await sql<
      { status: string }[]
    >`select status from public.draw_batches where id = ${s.id}`;
    assert.equal(bs!.status, "refunded");
  } finally {
    await db.drop();
  }
});

test("settlement: captured rules, participation + bonus once, overrides, NO_PRIZE, cutoff, replay/concurrency, changed config", async () => {
  const { db, sql, version } = await world("settle");
  try {
    const p = await sql<{ id: string; name: string }[]>`select id, name from public.prizes`;
    const silver = p.find((x) => x.name === "Silver Crate")!.id;
    const season = await activeSeason(sql, { rules: { prize_bonus_overrides: { [silver]: 0 } } });
    const u = await createUser(sql);
    await buySpins(sql, u, 10);

    const d = await drawConfirmed(sql, u, 4, version);
    // Change the prize catalogue and the global draw config after reservation: settlement uses what was captured.
    await rpc(sql, "admin_upsert_prize", {
      _id: p.find((x) => x.name === "Banana Chip")!.id,
      _name: "Banana Chip",
      _rarity: "legendary",
      _weight: 600,
      _inventory: null,
      _active: true,
      _fulfillment_type: "points_only",
      _actor: ADMIN_ACTOR,
    });
    await sql`update public.app_config set value = value || ${sql.json({ contract: addr(0xdead), chain_id: 1 } as never)} where key = 'vrf'`;

    const banana = await settle(sql, d.spinIds[0]!, await idx(sql, "Banana Chip"), d.requestId);
    assert.deepEqual(
      [banana.status, banana.scored, banana.participation_points, banana.bonus_points],
      ["fulfilled", true, "10", "25"],
      "common bonus captured before the rarity edit",
    );
    const s2 = await settle(sql, d.spinIds[1]!, await idx(sql, "Silver Crate"), d.requestId);
    assert.deepEqual(
      [s2.participation_points, s2.bonus_points],
      ["10", "0"],
      "explicit zero override",
    );
    assert.deepEqual(
      (await ledgerFor(sql, d.spinIds[1]!)).map((r) => [r.reward_subtype, r.amount]),
      [
        ["participation", "10"],
        ["prize_bonus", "0"],
      ],
    );

    // Concurrent replays of the same settlement score once.
    const vip = await idx(sql, "Charleston VIP Pass");
    await Promise.all(
      [1, 2, 3].map(() => settle(sql, d.spinIds[2]!, vip, d.requestId).catch((e: Error) => e)),
    );
    assert.deepEqual(
      (await ledgerFor(sql, d.spinIds[2]!)).map((r) => [r.reward_subtype, r.amount]),
      [
        ["participation", "10"],
        ["prize_bonus", "500"],
      ],
    );
    const [ent] = await sql<
      { status: string }[]
    >`select status from public.prize_entitlements where spin_id = ${d.spinIds[2]!}`;
    assert.equal(ent!.status, "owed", "real prize recorded as owed fulfilment");

    // NO_PRIZE returns the credit once, no points.
    const before = await (async () =>
      (
        await sql<
          { n: string }[]
        >`select count(*)::text n from public.spin_credits where user_id = ${u} and used_spin_id is null`
      )[0]!.n)();
    for (let i = 0; i < 2; i++) {
      await rpc(sql, "settle_spin", {
        _spin_id: d.spinIds[3],
        _chain_status: 2,
        _prize_index: 255,
        _random_word: "7",
        _request_id: d.requestId,
        _evidence: {},
      });
    }
    const after = (
      await sql<
        { n: string }[]
      >`select count(*)::text n from public.spin_credits where user_id = ${u} and used_spin_id is null`
    )[0]!.n;
    assert.equal(Number(after), Number(before) + 1);
    assert.equal((await ledgerFor(sql, d.spinIds[3]!)).length, 0);

    // Totals: 10+25 + 10+0 + 10+500
    const [score] = await sql<
      { total: string; participation_points: string; prize_points: string }[]
    >`select total::text, participation_points::text, prize_points::text from public.season_scores where season_id = ${season.id} and user_id = ${u}`;
    assert.deepEqual(
      [score!.total, score!.participation_points, score!.prize_points],
      ["555", "30", "525"],
    );
    const [batch] = await sql<
      { status: string }[]
    >`select status from public.draw_batches where id = ${d.batchId}`;
    assert.equal(batch!.status, "settled");

    // New reservations fail while the server still uses the old configuration (config changed underneath).
    await rejects(
      rpc(sql, "begin_draw_batch", {
        _user_id: u,
        _idempotency_key: "after-config-change",
        _count: 1,
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _pool_version: version,
      }),
      /configuration changed/,
    );
    await sql`update public.app_config set value = value || ${sql.json({ contract: CONTRACT, chain_id: CHAIN_ID } as never)} where key = 'vrf'`;

    // A request confirmed at/after the exclusive cutoff earns no seasonal points, but the prize is kept.
    const late = await drawConfirmed(sql, u, 1, version, { blockTime: new Date(season.ends_at) });
    const ls = await settle(sql, late.spinIds[0]!, await idx(sql, "Gold Crate"), late.requestId);
    assert.deepEqual([ls.status, ls.scored, ls.points], ["fulfilled", false, 0]);
    const [lent] = await sql<
      { status: string }[]
    >`select status from public.prize_entitlements where spin_id = ${late.spinIds[0]!}`;
    assert.equal(lent!.status, "owed");

    // Wrong request id or an index outside the captured mapping → conflict, draws pause.
    const bad = await drawConfirmed(sql, u, 1, version);
    const mismatch = await settle(sql, bad.spinIds[0]!, 0, "999999");
    assert.equal(mismatch.status, "pending", "nothing settled on a mismatching request id");
    const [cb] = await sql<
      { status: string }[]
    >`select status from public.draw_batches where id = ${bad.batchId}`;
    assert.equal(cb!.status, "conflict");
    await rejects(
      rpc(sql, "begin_draw_batch", {
        _user_id: u,
        _idempotency_key: "while-conflict",
        _count: 1,
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _pool_version: version,
      }),
      /finishing another draw/,
    );
    const [ready] = await rpc<{ machine_readiness: { open: boolean; reason: string } }>(
      sql,
      "machine_readiness",
      { _user_id: u },
    );
    assert.equal(ready!.machine_readiness.open, false);
    await rejects(
      rpc(sql, "resolve_batch_conflict", {
        _batch_id: bad.batchId,
        _resolution: "not_onchain",
        _evidence: { all_spins_none: true },
        _actor: ADMIN_ACTOR,
      }),
      /proof/,
    );
    await rpc(sql, "resolve_batch_conflict", {
      _batch_id: bad.batchId,
      _resolution: "confirmed",
      _evidence: { checked: "getSpins" },
      _actor: ADMIN_ACTOR,
    });
    await settle(sql, bad.spinIds[0]!, await idx(sql, "Banana Chip"), bad.requestId);
    assert.equal((await rpc(sql, "ledger_drift", { _season_id: season.id })).length, 0);
  } finally {
    await db.drop();
  }
});

test("events that don't match the reserved spins, and reorgs, pause draws instead of guessing", async () => {
  const { db, sql, version } = await world("conflict");
  try {
    const u = await createUser(sql);
    await buySpins(sql, u, 5);
    const [b] = await rpc<{ id: string; spin_ids: string[] }>(sql, "begin_draw_batch", {
      _user_id: u,
      _idempotency_key: "mismatch-1",
      _count: 2,
      _chain_id: CHAIN_ID,
      _contract: CONTRACT,
      _pool_version: version,
    });
    const tx = `0x${"c".repeat(64)}`;
    await rpc(sql, "record_signed_submission", {
      _batch_id: b!.id,
      _chain_id: CHAIN_ID,
      _operator: addr(0x0b),
      _nonce: 1,
      _tx_hash: tx,
      _raw_tx: "0x02",
    });
    const [r] = await rpc<{ status: string }>(sql, "record_request_receipt", {
      _tx_hash: tx,
      _success: true,
      _block_number: 5,
      _block_hash: `0x${"1".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 5,
      _min_confirmations: 3,
      _request_id: "77",
      _spin_ids: [b!.spin_ids[0]],
    });
    assert.equal(r!.status, "conflict");
    await rpc(sql, "resolve_batch_conflict", {
      _batch_id: b!.id,
      _resolution: "confirmed",
      _evidence: {},
      _actor: ADMIN_ACTOR,
    });
    await rpc(sql, "record_request_receipt", {
      _tx_hash: tx,
      _success: true,
      _block_number: 5,
      _block_hash: `0x${"1".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 5,
      _min_confirmations: 3,
      _request_id: "77",
      _spin_ids: b!.spin_ids,
    });
    // Same tx later reported in a different block: reorg → conflict + alert.
    const [re] = await rpc<{ status: string }>(sql, "record_request_receipt", {
      _tx_hash: tx,
      _success: true,
      _block_number: 6,
      _block_hash: `0x${"2".repeat(64)}`,
      _block_time: new Date(),
      _confirmations: 5,
      _min_confirmations: 3,
      _request_id: "77",
      _spin_ids: b!.spin_ids,
    });
    assert.equal(re!.status, "conflict");
    const alerts = await sql<
      { kind: string }[]
    >`select kind from public.ops_alerts where resolved_at is null`;
    assert.ok(alerts.some((a) => a.kind === "reorg"));
    // Proven never mined (all None, no receipts, nonce consumed by another final tx) → credits return.
    await rpc(sql, "resolve_batch_conflict", {
      _batch_id: b!.id,
      _resolution: "confirmed",
      _evidence: {},
      _actor: ADMIN_ACTOR,
    });
    const fresh = await createUser(sql);
    await buySpins(sql, fresh, 5);
    const [c2] = await rpc<{ id: string; spin_ids: string[] }>(sql, "begin_draw_batch", {
      _user_id: fresh,
      _idempotency_key: "ghost-batch-1",
      _count: 2,
      _chain_id: CHAIN_ID,
      _contract: CONTRACT,
      _pool_version: version,
    });
    await rpc(sql, "record_signed_submission", {
      _batch_id: c2!.id,
      _chain_id: CHAIN_ID,
      _operator: addr(0x0b),
      _nonce: 2,
      _tx_hash: `0x${"d".repeat(64)}`,
      _raw_tx: "0x03",
    });
    await rpc(sql, "flag_batch_conflict", {
      _batch_id: c2!.id,
      _reason: "operator nonce 2 consumed by a different transaction",
    });
    await rejects(
      rpc(sql, "resolve_batch_conflict", {
        _batch_id: c2!.id,
        _resolution: "not_onchain",
        _evidence: { all_spins_none: true, no_receipts: true },
        _actor: ADMIN_ACTOR,
      }),
      /proof/,
    );
    const [res] = await rpc<{ status: string }>(sql, "resolve_batch_conflict", {
      _batch_id: c2!.id,
      _resolution: "not_onchain",
      _evidence: {
        all_spins_none: true,
        no_receipts: true,
        nonce_consumed_by_other_tx_final: true,
      },
      _actor: ADMIN_ACTOR,
    });
    assert.equal(res!.status, "refunded");
    const [n] = await sql<
      { n: string }[]
    >`select count(*)::text n from public.spin_credits where user_id = ${fresh} and used_spin_id is null`;
    assert.equal(n!.n, "5");
  } finally {
    await db.drop();
  }
});

test("inventory: scarce stock drift keeps the entitlement; pool publication never replenishes from stale values", async () => {
  const db = await createDb({ label: "inventory" });
  const sql = db.sql;
  try {
    const p = await verifyEconomics(sql);
    await rpc(sql, "admin_upsert_prize", {
      _id: p.vip.id,
      _name: p.vip.name,
      _rarity: "legendary",
      _weight: 20,
      _inventory: 1,
      _active: true,
      _fulfillment_type: "fulfillment_required",
      _actor: ADMIN_ACTOR,
    });
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    const u = await createUser(sql);
    await buySpins(sql, u, 5);
    const d = await drawConfirmed(sql, u, 2, version);
    const vip = await idx(sql, "Charleston VIP Pass");
    await settle(sql, d.spinIds[0]!, vip, d.requestId);
    // Contract (or a bug) awards a second VIP the database has no stock for: keep it, alert.
    const s2 = await settle(sql, d.spinIds[1]!, vip, d.requestId);
    assert.equal(s2.status, "fulfilled");
    const alerts = await sql<
      { kind: string }[]
    >`select kind from public.ops_alerts where resolved_at is null`;
    assert.ok(alerts.some((a) => a.kind === "inventory_drift"));
    const ents = await sql`select 1 from public.prize_entitlements where prize_id = ${p.vip.id}`;
    assert.equal(ents.length, 2);

    // Direct stock increases on a published prize are refused.
    await rejects(
      rpc(sql, "admin_upsert_prize", {
        _id: p.gold.id,
        _name: p.gold.name,
        _rarity: "epic",
        _weight: 100,
        _inventory: 9999,
        _active: true,
        _fulfillment_type: "fulfillment_required",
        _actor: ADMIN_ACTOR,
      }),
      /audited restock/,
    );

    // Publication requires the chain to be reconciled.
    const order = await sql<
      { name: string; i: number; inventory: number | null }[]
    >`select name, onchain_index as i, inventory from public.prizes order by onchain_index`;
    const chainRemaining = order.map((r) =>
      r.inventory == null ? 4294967295n : BigInt(r.inventory),
    );
    await rejects(
      rpc(sql, "prepare_pool_publication", {
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _chain_pool_version: version,
        _chain_remaining: chainRemaining.map(String),
        _chain_pending: 1,
        _actor: ADMIN_ACTOR,
      }),
      /pending request/,
    );
    await rejects(
      rpc(sql, "prepare_pool_publication", {
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _chain_pool_version: version + 5,
        _chain_remaining: chainRemaining.map(String),
        _chain_pending: 0,
        _actor: ADMIN_ACTOR,
      }),
      /reconcile first/,
    );
    // Chain consumed more Gold than the DB knows (unsettled/stale DB): refuse to publish DB stock.
    const gi = order.findIndex((r) => r.name === "Gold Crate");
    const staleChain = chainRemaining.slice();
    staleChain[gi] = staleChain[gi]! - 3n;
    await rejects(
      rpc(sql, "prepare_pool_publication", {
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _chain_pool_version: version,
        _chain_remaining: staleChain.map(String),
        _chain_pending: 0,
        _actor: ADMIN_ACTOR,
      }),
      /exceeds on-chain remaining/,
    );
    // A restock doesn't hide drift (DB 500 > chain 497 stays refused even with +3 audited)...
    await rpc(sql, "restock_prize", {
      _prize_id: p.gold.id,
      _quantity: 3,
      _evidence: "new crates delivered",
      _actor: ADMIN_ACTOR,
    });
    await sql`update public.prize_economics set stock_verified_qty = 600 where prize_id = ${p.gold.id}`;
    await rejects(
      rpc(sql, "prepare_pool_publication", {
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _chain_pool_version: version,
        _chain_remaining: staleChain.map(String),
        _chain_pending: 0,
        _actor: ADMIN_ACTOR,
      }),
      /exceeds on-chain remaining/,
    );
    // ...reconciling the DB down to the chain does; then the audited restock is published on top.
    await rpc(sql, "admin_upsert_prize", {
      _id: p.gold.id,
      _name: p.gold.name,
      _rarity: "epic",
      _weight: 100,
      _inventory: 500,
      _active: true,
      _fulfillment_type: "fulfillment_required",
      _actor: ADMIN_ACTOR,
    });
    const ok = await publishPool(sql, staleChain, version, version + 1);
    assert.equal(ok.version, version + 1);
    assert.equal(String(ok.publication.remaining[gi]), "500", "chain 497 + audited restock 3");
    // Pool versions must match for new reservations.
    await rejects(
      rpc(sql, "begin_draw_batch", {
        _user_id: u,
        _idempotency_key: "old-pool-version",
        _count: 1,
        _chain_id: CHAIN_ID,
        _contract: CONTRACT,
        _pool_version: version,
      }),
      /differ from the published odds/,
    );
  } finally {
    await db.drop();
  }
});

test("ordinary players get machine readiness without config-table access", async () => {
  const db = await createDb({ label: "ready" });
  const sql = db.sql;
  try {
    const u = await createUser(sql);
    let [r] = await rpc<{ machine_readiness: { open: boolean; reason: string } }>(
      sql,
      "machine_readiness",
      { _user_id: u },
    );
    assert.equal(r!.machine_readiness.open, false);
    assert.match(r!.machine_readiness.reason, /being switched on/);
    await enableVrf(sql);
    [r] = await rpc(sql, "machine_readiness", { _user_id: u });
    assert.match(r!.machine_readiness.reason, /haven't been published/);
    await verifyEconomics(sql);
    await publishPool(sql);
    await activeSeason(sql);
    const [ok] = await rpc<{
      machine_readiness: {
        open: boolean;
        expected_bonus_per_spin: number;
        expected_points_per_spin: number;
        odds: unknown[];
      };
    }>(sql, "machine_readiness", { _user_id: u });
    assert.equal(ok!.machine_readiness.open, true);
    assert.equal(
      Number(ok!.machine_readiness.expected_bonus_per_spin),
      78,
      "600/280/100/20 with 25/100/250/500",
    );
    assert.equal(Number(ok!.machine_readiness.expected_points_per_spin), 88);
    assert.equal(ok!.machine_readiness.odds.length, 4);
  } finally {
    await db.drop();
  }
});
