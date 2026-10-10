// End-to-end draw engine tests: real GotchaVRF + Chainlink VRFCoordinatorV2_5Mock on anvil, real PostgreSQL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseEventLogs, type Hex, type PublicClient, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, KEYS, pgDb, startAnvil } from "./anvil";
import { createDb, createUser, rpc, type Sql } from "../../supabase/tests/db/harness";
import {
  activeSeason,
  ADMIN_ACTOR,
  buySpins,
  verifyEconomics,
} from "../../supabase/tests/db/fixtures";
import {
  reserveAndSubmit,
  runSettlementPass,
  gatherConflictEvidence,
  DrawError,
  type DrawDeps,
  type DrawBatch,
} from "../../src/lib/draws.server";
import { readPool } from "../../src/lib/vrf.server";
import { gotchaVrfAbi } from "../../src/lib/gotchaVrfAbi";

let anvil: Awaited<ReturnType<typeof startAnvil>>;
const coordArt = artifact("VRFCoordinatorV2_5Mock.sol", "VRFCoordinatorV2_5Mock");
const gotchaArt = artifact("GotchaVRF.sol", "GotchaVRF");
const operator = privateKeyToAccount(KEYS.operator);

before(async () => {
  anvil = await startAnvil();
});
after(() => anvil?.stop());

async function world(label: string) {
  const db = await createDb({ label });
  const sql = db.sql;
  const owner = anvil.wallet(KEYS.owner);
  const coord = await anvil.deploy(coordArt, [10n ** 17n, 10n ** 9n, 4n * 10n ** 15n]);
  const createHash = await owner.writeContract({
    address: coord,
    abi: coordArt.abi,
    functionName: "createSubscription",
    args: [],
    account: owner.account!,
    chain: anvil.chain,
  });
  const rc = await anvil.pub.waitForTransactionReceipt({ hash: createHash });
  const created = parseEventLogs({
    abi: coordArt.abi,
    logs: rc.logs,
    eventName: "SubscriptionCreated" as never,
  })[0] as unknown as { args: { subId: bigint } };
  const subId = created.args.subId;
  await anvil.pub.waitForTransactionReceipt({
    hash: await owner.writeContract({
      address: coord,
      abi: coordArt.abi,
      functionName: "fundSubscription",
      args: [subId, 10n ** 21n],
      account: owner.account!,
      chain: anvil.chain,
    }),
  });
  const gotcha = await anvil.deploy(gotchaArt, [
    coord,
    subId,
    keccak256(toHex("lane")),
    1,
    100_000,
    100_000,
    false,
    operator.address,
  ]);
  await anvil.pub.waitForTransactionReceipt({
    hash: await owner.writeContract({
      address: coord,
      abi: coordArt.abi,
      functionName: "addConsumer",
      args: [subId, gotcha],
      account: owner.account!,
      chain: anvil.chain,
    }),
  });

  await verifyEconomics(sql);
  await sql`update public.app_config set value = value || ${sql.json({ enabled: true, chain_id: 31337, contract: gotcha.toLowerCase(), rpc_url: anvil.url, min_confirmations: 2 } as never)} where key = 'vrf'`;
  // Publish the pool exactly like adminPublishPool: reconcile → setPool → read back → confirm.
  const before = await readPool(anvil.pub, gotcha);
  const [prep] = await rpc<{ id: string; weights: string[]; remaining: string[] }>(
    sql,
    "prepare_pool_publication",
    {
      _chain_id: 31337,
      _contract: gotcha.toLowerCase(),
      _chain_pool_version: null,
      _chain_remaining: before.remaining.map(String),
      _chain_pending: before.pending,
      _actor: ADMIN_ACTOR,
    },
  );
  const op = anvil.wallet(KEYS.operator);
  const setHash = await op.writeContract({
    address: gotcha,
    abi: gotchaVrfAbi,
    functionName: "setPool",
    args: [prep!.weights.map(Number), prep!.remaining.map(Number)],
    account: op.account!,
    chain: anvil.chain,
  });
  await rpc(sql, "mark_pool_publication_sent", { _publication_id: prep!.id, _tx_hash: setHash });
  await anvil.pub.waitForTransactionReceipt({ hash: setHash });
  const afterPool = await readPool(anvil.pub, gotcha);
  await rpc(sql, "confirm_pool_publication", {
    _publication_id: prep!.id,
    _pool_version: afterPool.version,
    _chain_weights: afterPool.weights.map(String),
    _chain_remaining: afterPool.remaining.map(String),
    _actor: ADMIN_ACTOR,
  });
  const season = await activeSeason(sql);
  const user = await createUser(sql);
  await buySpins(sql, user, 10);
  const deps = (pub: PublicClient = anvil.pub): DrawDeps => ({
    db: pgDb(sql),
    chain: (id) => (id === 31337 ? pub : null),
    operator: () => operator,
    minConfirmations: 2,
    receiptWaitMs: 1500,
  });
  return { db, sql, coord, gotcha, season, user, deps };
}

async function fulfil(coord: Hex, gotcha: Hex, requestId: bigint, words: bigint[]) {
  const w = anvil.wallet(KEYS.owner);
  const hash = await w.writeContract({
    address: coord,
    abi: coordArt.abi,
    functionName: "fulfillRandomWordsWithOverride",
    args: [requestId, gotcha, words],
    account: w.account!,
    chain: anvil.chain,
  });
  await anvil.pub.waitForTransactionReceipt({ hash });
}

async function batchOf(sql: Sql, id: string) {
  const [b] = await sql<DrawBatch[]>`select * from public.draw_batches where id = ${id}`;
  return b!;
}
async function unusedCredits(sql: Sql, u: string) {
  return Number(
    (
      await sql<
        { n: string }[]
      >`select count(*)::text n from public.spin_credits where user_id = ${u} and used_spin_id is null`
    )[0]!.n,
  );
}

test("happy path: requestId from confirmed events, settlement by the worker, points once", async () => {
  const w = await world("chainhappy");
  try {
    const r = await reserveAndSubmit(w.deps(), {
      userId: w.user,
      idempotencyKey: "happy-path-01",
      count: 3,
      chainId: 31337,
      contract: w.gotcha,
    });
    assert.equal(
      (await batchOf(w.sql, r.batch.id)).status,
      "broadcast",
      "1 confirmation < 2 required",
    );
    await anvil.mine(1);
    const rep = await runSettlementPass(w.deps());
    const b = await batchOf(w.sql, r.batch.id);
    assert.equal(
      b.status,
      "confirmed",
      JSON.stringify({ rep, alerts: await w.sql`select message from public.ops_alerts` }),
    );
    const receipt = await anvil.pub.getTransactionReceipt({ hash: r.txHash as Hex });
    const ev = parseEventLogs({
      abi: gotchaVrfAbi,
      logs: receipt.logs,
      eventName: "SpinRequested",
    });
    assert.equal(
      b.request_id,
      ev[0]!.args.requestId.toString(),
      "request id parsed from the confirmed SpinRequested events",
    );

    // Same idempotency key again: same batch, no second request.
    const again = await reserveAndSubmit(w.deps(), {
      userId: w.user,
      idempotencyKey: "happy-path-01",
      count: 3,
      chainId: 31337,
      contract: w.gotcha,
    });
    assert.equal(again.batch.id, r.batch.id);
    assert.equal(again.resumed, true);

    // Pending on-chain: worker passes never refund or settle early.
    for (let i = 0; i < 3; i++) await runSettlementPass(w.deps());
    assert.equal(await unusedCredits(w.sql, w.user), 7);

    await fulfil(w.coord, w.gotcha, BigInt(b.request_id!), [5n, 600n, 985n]); // common, rare, legendary
    await anvil.mine(2);
    await runSettlementPass(w.deps());
    const spins = await w.sql<
      { status: string; rarity: string; points: number; random_word: string }[]
    >`select status, rarity, points, random_word from public.spins where batch_id = ${r.batch.id}`;
    const bonus: Record<string, number> = { common: 25, rare: 100, epic: 250, legendary: 500 };
    for (const s of spins) {
      assert.equal(s.status, "fulfilled");
      assert.equal(s.points, 10 + bonus[s.rarity]!, `participation + ${s.rarity} bonus`);
    }
    // The prize is the one the contract recorded for that spin.
    for (const id of r.batch.spin_ids) {
      const [onchain] = await anvil.pub.readContract({
        address: w.gotcha,
        abi: gotchaVrfAbi,
        functionName: "getSpins",
        args: [[`0x${id.replace(/-/g, "").padStart(64, "0")}` as Hex]],
      });
      const [db] = await w.sql<
        { prize_onchain_index: number }[]
      >`select prize_onchain_index from public.spins where id = ${id}`;
      assert.equal(db!.prize_onchain_index, Number(onchain!.prizeIndex));
    }
    await runSettlementPass(w.deps());
    const [{ total }] = await w.sql<
      { total: string }[]
    >`select total::text from public.season_scores where season_id = ${w.season.id} and user_id = ${w.user}`;
    assert.equal(
      Number(total),
      spins.reduce((a, s) => a + s.points, 0),
      "scored once",
    );
  } finally {
    await w.db.drop();
  }
});

test("lost response after broadcast: stays reserved, the worker records the same transaction", async () => {
  const w = await world("chainlost");
  try {
    const flaky = anvil.interceptedClient(async (method, _p, forward) => {
      if (method === "eth_sendRawTransaction") {
        await forward();
        throw new Error("socket hang up");
      }
      return forward();
    });
    const r = await reserveAndSubmit(w.deps(flaky), {
      userId: w.user,
      idempotencyKey: "lost-response-1",
      count: 2,
      chainId: 31337,
      contract: w.gotcha,
    });
    const subs = await w.sql<
      { tx_hash: string; status: string; raw_tx: string }[]
    >`select tx_hash, status, raw_tx from public.draw_submissions where batch_id = ${r.batch.id}`;
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.status, "signed", "ambiguous broadcast is not assumed either way");
    assert.equal(await unusedCredits(w.sql, w.user), 8, "no refund");
    await anvil.mine(2);
    await runSettlementPass(w.deps());
    const b = await batchOf(w.sql, r.batch.id);
    assert.equal(b.status, "confirmed");
    assert.equal(b.request_tx, subs[0]!.tx_hash);
  } finally {
    await w.db.drop();
  }
});

test("dropped before reaching the node: the worker resends the SAME signed bytes", async () => {
  const w = await world("chaindrop");
  try {
    const dropping = anvil.interceptedClient(async (method, _p, forward) => {
      if (method === "eth_sendRawTransaction") throw new Error("fetch failed");
      return forward();
    });
    const r = await reserveAndSubmit(w.deps(dropping), {
      userId: w.user,
      idempotencyKey: "dropped-tx-001",
      count: 1,
      chainId: 31337,
      contract: w.gotcha,
    });
    const [sub] = await w.sql<
      { tx_hash: string; raw_tx: string }[]
    >`select tx_hash, raw_tx from public.draw_submissions where batch_id = ${r.batch.id}`;
    assert.equal(
      await anvil.pub.getTransaction({ hash: sub!.tx_hash as Hex }).catch(() => null),
      null,
      "never reached the node",
    );
    await runSettlementPass(w.deps()); // resend
    await anvil.mine(2);
    await runSettlementPass(w.deps());
    const b = await batchOf(w.sql, r.batch.id);
    assert.equal(b.status, "confirmed");
    assert.equal(b.request_tx, sub!.tx_hash, "same transaction hash as stored before broadcast");
    assert.equal(
      (await w.sql`select 1 from public.draw_submissions where batch_id = ${r.batch.id}`).length,
      1,
    );
    assert.equal(keccak256(sub!.raw_tx as Hex), sub!.tx_hash);
  } finally {
    await w.db.drop();
  }
});

test("operator nonce taken by another transaction → conflict, then proven not on-chain → credits return", async () => {
  const w = await world("chainnonce");
  try {
    const dropping = anvil.interceptedClient(async (method, _p, forward) => {
      if (method === "eth_sendRawTransaction") throw new Error("fetch failed");
      return forward();
    });
    const r = await reserveAndSubmit(w.deps(dropping), {
      userId: w.user,
      idempotencyKey: "nonce-taken-01",
      count: 2,
      chainId: 31337,
      contract: w.gotcha,
    });
    const [sub] = await w.sql<
      { nonce: string }[]
    >`select nonce::text from public.draw_submissions where batch_id = ${r.batch.id}`;
    // Someone else uses the operator key at the same nonce (e.g. a manual transfer).
    const op = anvil.wallet(KEYS.operator);
    const other = await op.sendTransaction({
      to: privateKeyToAccount(KEYS.other).address,
      value: 1n,
      nonce: Number(sub!.nonce),
      account: op.account!,
      chain: anvil.chain,
    });
    await anvil.pub.waitForTransactionReceipt({ hash: other });
    await runSettlementPass(w.deps());
    let b = await batchOf(w.sql, r.batch.id);
    assert.equal(b.status, "conflict");
    assert.equal(await unusedCredits(w.sql, w.user), 8, "no automatic refund");
    // New draws pause while a batch is in conflict.
    await assert.rejects(
      reserveAndSubmit(w.deps(), {
        userId: w.user,
        idempotencyKey: "while-conflict-1",
        count: 1,
        chainId: 31337,
        contract: w.gotcha,
      }),
      /finishing another draw/,
    );
    await anvil.mine(70); // past finalized depth
    const evidence = await gatherConflictEvidence(w.deps(), b);
    assert.deepEqual(
      [evidence.all_spins_none, evidence.no_receipts, evidence.nonce_consumed_by_other_tx_final],
      [true, true, true],
    );
    await rpc(w.sql, "resolve_batch_conflict", {
      _batch_id: b.id,
      _resolution: "not_onchain",
      _evidence: evidence,
      _actor: ADMIN_ACTOR,
    });
    b = await batchOf(w.sql, r.batch.id);
    assert.equal(b.status, "refunded");
    assert.equal(await unusedCredits(w.sql, w.user), 10);
  } finally {
    await w.db.drop();
  }
});

test("closed browser + changed global config: worker settles with the captured chain and contract", async () => {
  const w = await world("chainconfig");
  try {
    const r = await reserveAndSubmit(w.deps(), {
      userId: w.user,
      idempotencyKey: "captured-cfg-1",
      count: 1,
      chainId: 31337,
      contract: w.gotcha,
    });
    await anvil.mine(2);
    await runSettlementPass(w.deps());
    const b = await batchOf(w.sql, r.batch.id);
    // Operators move the app to a new chain/contract while this spin is still pending.
    await w.sql`update public.app_config set value = value || ${w.sql.json({ chain_id: 8453, contract: "0x" + "1".repeat(40), enabled: false } as never)} where key = 'vrf'`;
    await fulfil(w.coord, w.gotcha, BigInt(b.request_id!), [7n]);
    await anvil.mine(2);
    await runSettlementPass(w.deps()); // the player never comes back
    const [s] = await w.sql<
      { status: string }[]
    >`select status from public.spins where batch_id = ${r.batch.id}`;
    assert.equal(s!.status, "fulfilled");
  } finally {
    await w.db.drop();
  }
});

test("proven pre-broadcast failure refunds; paused contract refuses before reserving", async () => {
  const w = await world("chainprebroadcast");
  try {
    const failingSim = anvil.interceptedClient(async (method, _p, forward) => {
      if (method === "eth_call" && (_p as { data?: string }[])?.[0]?.data?.startsWith?.("0x")) {
        const data = (_p as { data?: string }[])[0]!.data!;
        if (data.length > 200) throw new Error("execution reverted: EmptyPool()"); // the requestSpins simulation
      }
      return forward();
    });
    await assert.rejects(
      reserveAndSubmit(w.deps(failingSim), {
        userId: w.user,
        idempotencyKey: "sim-failure-01",
        count: 2,
        chainId: 31337,
        contract: w.gotcha,
      }),
      (e: DrawError) => e.refunded === true,
    );
    assert.equal(await unusedCredits(w.sql, w.user), 10);
    const owner = anvil.wallet(KEYS.owner);
    await anvil.pub.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: w.gotcha,
        abi: gotchaVrfAbi,
        functionName: "setRequestsPaused",
        args: [true],
        account: owner.account!,
        chain: anvil.chain,
      }),
    });
    await assert.rejects(
      reserveAndSubmit(w.deps(), {
        userId: w.user,
        idempotencyKey: "paused-contract",
        count: 1,
        chainId: 31337,
        contract: w.gotcha,
      }),
      /paused on-chain/,
    );
    assert.equal(await unusedCredits(w.sql, w.user), 10);
  } finally {
    await w.db.drop();
  }
});
