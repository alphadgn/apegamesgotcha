// Draw engine: reserve → sign (persist) → broadcast → confirm → settle, and the settlement worker.
//
// Rules this module follows (see supabase/migrations/20261010090400_draw_batches_and_settlement.sql):
// * Chainlink VRF is the only outcome authority; we only record what the contract drew.
// * The signed transaction is stored BEFORE broadcast; recovery resends the SAME bytes.
// * requestId comes from confirmed SpinRequested events, never from a simulation.
// * Credits are refunded only for proven pre-broadcast failure or a canonically confirmed revert.
//   A timeout, a network error or getSpin=None never refunds anything.
// * Settlement uses each batch's captured chain, contract, rules and prize mapping.
import { encodeFunctionData, keccak256, parseEventLogs, type Hex, type PublicClient } from "viem";
import type { LocalAccount } from "viem/accounts";
import { gotchaVrfAbi } from "./gotchaVrfAbi";
import { bytes32ToUuid, ChainStatus, readSpins, uuidToBytes32 } from "./vrf.server";
import type { Db } from "./db-rpc";

export type DrawBatch = {
  id: string;
  user_id: string;
  spin_ids: string[];
  spin_count: number;
  status:
    | "reserved"
    | "signed"
    | "broadcast"
    | "confirmed"
    | "settled"
    | "reverted"
    | "refunded"
    | "conflict";
  chain_id: number;
  contract_address: string;
  pool_version: string | number;
  request_id: string | null;
  request_tx: string | null;
  request_block: string | number | null;
  request_block_hash: string | null;
  submission_claimed_at: string | null;
  created_at: string;
};

export type Submission = {
  id: string;
  batch_id: string;
  chain_id: number;
  operator_address: string;
  nonce: string | number;
  tx_hash: string;
  raw_tx: string;
  status: "signed" | "broadcast" | "mined" | "reverted" | "replaced";
};

export type DrawDeps = {
  db: Db;
  /** Public client for a chain id (the batch's captured chain), or null when no RPC is configured for it. */
  chain: (chainId: number) => PublicClient | null;
  /** The operator signer (server key). */
  operator: () => LocalAccount;
  minConfirmations: number;
  /** How long to wait for a request receipt inside the player's request before handing over to the worker. */
  receiptWaitMs?: number;
  now?: () => number;
};

export class DrawError extends Error {
  constructor(
    message: string,
    readonly refunded: boolean,
  ) {
    super(message);
  }
}

function errText(e: unknown) {
  const x = e as { shortMessage?: string; message?: string };
  return (x?.shortMessage ?? x?.message ?? String(e)).slice(0, 300);
}

async function refundPrebroadcast(deps: DrawDeps, batchId: string, reason: string) {
  try {
    await deps.db.rpc("refund_batch_prebroadcast", { _batch_id: batchId, _reason: reason });
    return true;
  } catch {
    return false; // a submission exists (or the DB is unreachable): keep the credits reserved
  }
}

/**
 * Reserve credits for a draw and submit the Chainlink request.
 * Safe to call again with the same idempotency key: the same batch comes back and is not resubmitted.
 */
export async function reserveAndSubmit(
  deps: DrawDeps,
  input: {
    userId: string;
    idempotencyKey: string;
    count: number;
    chainId: number;
    contract: string;
  },
) {
  const pub = deps.chain(input.chainId);
  if (!pub) throw new DrawError("The draw network is not configured.", false);
  const contract = input.contract as Hex;
  const [poolVersion, paused] = await Promise.all([
    pub.readContract({ address: contract, abi: gotchaVrfAbi, functionName: "poolVersion" }),
    pub.readContract({ address: contract, abi: gotchaVrfAbi, functionName: "requestsPaused" }),
  ]);
  if (paused)
    throw new DrawError("New draws are paused on-chain right now. Your spins are saved.", false);

  const [batch] = await deps.db.rpc<DrawBatch>("begin_draw_batch", {
    _user_id: input.userId,
    _idempotency_key: input.idempotencyKey,
    _count: input.count,
    _chain_id: input.chainId,
    _contract: input.contract.toLowerCase(),
    _pool_version: Number(poolVersion),
  });
  if (!batch) throw new DrawError("Couldn't reserve your spins.", false);
  const [claimed] = await deps.db.rpc<boolean | { claim_batch_submission: boolean }>(
    "claim_batch_submission",
    { _batch_id: batch.id },
  );
  const isClaimed = typeof claimed === "boolean" ? claimed : !!claimed?.claim_batch_submission;
  if (!isClaimed) return { batch, txHash: batch.request_tx, resumed: true as const };

  // ---- Pre-broadcast: anything that fails here provably never reached the chain ----
  let raw: Hex;
  let hash: Hex;
  const account = (() => {
    try {
      return deps.operator();
    } catch (e) {
      return e as Error;
    }
  })();
  if (account instanceof Error) {
    await refundPrebroadcast(deps, batch.id, account.message);
    throw new DrawError("Draws are being set up. Your spins were returned.", true);
  }
  try {
    const ids = batch.spin_ids.map(uuidToBytes32);
    // Simulation only checks the call would succeed (pool, pause, duplicate ids). Its return value is ignored.
    await pub.simulateContract({
      account,
      address: contract,
      abi: gotchaVrfAbi,
      functionName: "requestSpins",
      args: [ids],
    });
    const data = encodeFunctionData({
      abi: gotchaVrfAbi,
      functionName: "requestSpins",
      args: [ids],
    });
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const req = await pub.prepareTransactionRequest({
      account,
      to: contract,
      data,
      nonce,
      chain: pub.chain,
    });
    raw = await account.signTransaction(req as Parameters<LocalAccount["signTransaction"]>[0]);
    hash = keccak256(raw);
    await deps.db.rpc("record_signed_submission", {
      _batch_id: batch.id,
      _chain_id: input.chainId,
      _operator: account.address.toLowerCase(),
      _nonce: nonce,
      _tx_hash: hash,
      _raw_tx: raw,
    });
  } catch (e) {
    const refunded = await refundPrebroadcast(deps, batch.id, errText(e));
    throw new DrawError(
      refunded
        ? `Couldn't start the Chainlink draw (${errText(e)}). Your spins were returned.`
        : "The draw is being confirmed. Your spins are reserved and will settle automatically.",
      refunded,
    );
  }

  // ---- Broadcast: from here on, failures are ambiguous and never refund ----
  try {
    await pub.sendRawTransaction({ serializedTransaction: raw });
    await deps.db.rpc("mark_submission_broadcast", { _tx_hash: hash, _error: null });
  } catch (e) {
    await deps.db
      .rpc("mark_submission_broadcast", { _tx_hash: hash, _error: errText(e) })
      .catch(() => {});
    return { batch, txHash: hash, resumed: false as const };
  }

  try {
    await pub.waitForTransactionReceipt({
      hash,
      timeout: deps.receiptWaitMs ?? 20_000,
      pollingInterval: 1_000,
    });
    await recordReceipt(deps, pub, batch, hash);
  } catch {
    /* slow inclusion: the worker (or the next status check) records it */
  }
  return { batch, txHash: hash, resumed: false as const };
}

/** Read a request receipt and record it (confirmations, block hash, events). Returns false if not mined yet. */
export async function recordReceipt(
  deps: DrawDeps,
  pub: PublicClient,
  batch: Pick<DrawBatch, "id" | "contract_address">,
  hash: Hex,
) {
  const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return false;
  const head = await pub.getBlockNumber();
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  const confirmations = Number(head - receipt.blockNumber + 1n);
  const events = parseEventLogs({
    abi: gotchaVrfAbi,
    logs: receipt.logs,
    eventName: "SpinRequested",
  }).filter((l) => l.address.toLowerCase() === batch.contract_address.toLowerCase());
  const requestIds = [...new Set(events.map((e) => e.args.requestId.toString()))];
  await deps.db.rpc("record_request_receipt", {
    _tx_hash: hash,
    _success: receipt.status === "success",
    _block_number: Number(receipt.blockNumber),
    _block_hash: receipt.blockHash,
    _block_time: new Date(Number(block.timestamp) * 1000).toISOString(),
    _confirmations: confirmations,
    _min_confirmations: deps.minConfirmations,
    _request_id: requestIds.length === 1 ? requestIds[0] : null,
    _spin_ids: events.map((e) => bytes32ToUuid(e.args.spinId)),
  });
  return true;
}

/** Bring one batch forward. Never refunds on a timeout. */
export async function reconcileBatch(deps: DrawDeps, batch: DrawBatch): Promise<string> {
  const pub = deps.chain(batch.chain_id);
  if (!pub) {
    await deps.db.rpc("raise_ops_alert", {
      _key: `rpc_missing:${batch.chain_id}`,
      _kind: "stuck_draw",
      _severity: "critical",
      _message: `No RPC configured for chain ${batch.chain_id}; draws on it can't settle (set vrf.rpc_by_chain).`,
      _details: { batch_id: batch.id },
    });
    return "no-rpc";
  }
  const now = deps.now?.() ?? Date.now();

  if (batch.status === "reserved") {
    const subs = await deps.db.select<Submission>("draw_submissions", { batch_id: batch.id });
    // Nothing signed after 2 minutes: the submitter died before signing → provably never broadcast.
    if (!subs.length && now - Date.parse(batch.created_at) > 120_000) {
      await refundPrebroadcast(deps, batch.id, "never signed (submitter stopped)");
      return "refunded";
    }
    return "waiting";
  }

  if (batch.status === "signed" || batch.status === "broadcast") {
    const subs = await deps.db.select<Submission>("draw_submissions", { batch_id: batch.id });
    for (const s of subs) {
      if (await recordReceipt(deps, pub, batch, s.tx_hash as Hex)) return "receipt";
    }
    for (const s of subs) {
      if (s.status === "replaced") continue;
      const inPool = await pub.getTransaction({ hash: s.tx_hash as Hex }).catch(() => null);
      if (inPool) continue;
      const mined = await pub.getTransactionCount({
        address: s.operator_address as Hex,
        blockTag: "latest",
      });
      if (mined > Number(s.nonce)) {
        // Our nonce was used, yet none of our hashes has a receipt: another transaction took it.
        await deps.db.rpc("flag_batch_conflict", {
          _batch_id: batch.id,
          _reason: `operator nonce ${s.nonce} consumed by a different transaction`,
        });
        return "conflict";
      }
      // Not known to the node: resend the SAME signed bytes.
      try {
        await pub.sendRawTransaction({ serializedTransaction: s.raw_tx as Hex });
        await deps.db.rpc("mark_submission_broadcast", { _tx_hash: s.tx_hash, _error: null });
      } catch (e) {
        await deps.db.rpc("mark_submission_broadcast", { _tx_hash: s.tx_hash, _error: errText(e) });
      }
    }
    return "pending";
  }

  if (batch.status === "confirmed") {
    // Re-verify the request is still canonical (reorg check), then settle what Chainlink has answered.
    if (batch.request_tx) await recordReceipt(deps, pub, batch, batch.request_tx as Hex);
    const [fresh] = await deps.db.select<DrawBatch>("draw_batches", { id: batch.id });
    if (!fresh || fresh.status !== "confirmed") return fresh?.status ?? "missing";
    return settleBatch(deps, pub, fresh);
  }
  return batch.status;
}

/** Settle every spin of a confirmed batch whose outcome is final on-chain. */
export async function settleBatch(deps: DrawDeps, pub: PublicClient, batch: DrawBatch) {
  const spins = await deps.db.select<{ id: string; status: string }>(
    "spins",
    { batch_id: batch.id },
    "id, status",
  );
  const pending = spins.filter((s) => s.status === "pending").map((s) => s.id);
  if (!pending.length) return "settled";
  const head = await pub.getBlockNumber();
  const readAt = head - BigInt(Math.max(deps.minConfirmations - 1, 0));
  const block = await pub.getBlock({ blockNumber: readAt });
  const rows = await readSpins(pub, batch.contract_address, pending, readAt);
  let settled = 0;
  for (const r of rows) {
    if (r.status === ChainStatus.Pending) continue;
    if (r.status === ChainStatus.None) {
      await deps.db.rpc("flag_batch_conflict", {
        _batch_id: batch.id,
        _reason: `spin ${r.id} has no request on the contract at block ${readAt}`,
      });
      return "conflict";
    }
    await deps.db.rpc("settle_spin", {
      _spin_id: r.id,
      _chain_status: r.status,
      _prize_index: r.prizeIndex,
      _random_word: r.randomWord.toString(),
      _request_id: r.requestId.toString(),
      _evidence: {
        read_block: Number(readAt),
        read_block_hash: block.hash,
        chain_id: batch.chain_id,
        contract: batch.contract_address,
      },
    });
    settled++;
  }
  return settled === rows.length ? "settled" : "partial";
}

/** One pass of the protected settlement worker. */
export async function runSettlementPass(deps: DrawDeps, limit = 50) {
  const report: Record<string, number> = {};
  await deps.db.rpc("advance_season_states", {});
  const work = await deps.db.rpc<DrawBatch>("open_draw_work", { _limit: limit });
  for (const b of work) {
    let outcome: string;
    try {
      outcome = await reconcileBatch(deps, b);
    } catch (e) {
      outcome = "error";
      await deps.db
        .rpc("raise_ops_alert", {
          _key: `settle_error:${b.id}`,
          _kind: "stuck_draw",
          _severity: "warning",
          _message: `Settlement worker error: ${errText(e)}`,
          _details: { batch_id: b.id, status: b.status },
        })
        .catch(() => {});
    }
    report[outcome] = (report[outcome] ?? 0) + 1;
  }
  return report;
}

/**
 * On-chain evidence for resolving a conflicted batch. "not_onchain" is proven only when every spin reads None
 * on the contract, none of our submissions has a receipt, and the operator nonce we used was consumed by a
 * different transaction at finalized depth (so ours can never be mined).
 */
export async function gatherConflictEvidence(deps: DrawDeps, batch: DrawBatch) {
  const pub = deps.chain(batch.chain_id);
  if (!pub) throw new Error(`No RPC configured for chain ${batch.chain_id}`);
  const spins = await readSpins(pub, batch.contract_address, batch.spin_ids);
  const subs = await deps.db.select<Submission>("draw_submissions", { batch_id: batch.id });
  const receipts = await Promise.all(
    subs.map((s) => pub.getTransactionReceipt({ hash: s.tx_hash as Hex }).catch(() => null)),
  );
  let nonceConsumed = subs.length === 0;
  let finalizedBlock: string | null = null;
  if (subs.length) {
    const finalized = await pub.getBlock({ blockTag: "finalized" }).catch(() => null);
    finalizedBlock = finalized?.number?.toString() ?? null;
    if (finalized?.number != null) {
      const nonceAtFinal = await pub.getTransactionCount({
        address: subs[0]!.operator_address as Hex,
        blockNumber: finalized.number,
      });
      nonceConsumed = nonceAtFinal > Number(subs[0]!.nonce) && receipts.every((r) => r == null);
    }
  }
  return {
    checked_at: new Date().toISOString(),
    chain_id: batch.chain_id,
    contract: batch.contract_address,
    spin_statuses: spins.map((s) => s.status),
    all_spins_none: spins.every((s) => s.status === ChainStatus.None),
    no_receipts: receipts.every((r) => r == null),
    finalized_block: finalizedBlock,
    nonce_consumed_by_other_tx_final: nonceConsumed,
  };
}
