// Draw submission + settlement, shared by startDraw/checkDraw and the protected scheduled worker.
// Everything here is replay-safe: the database functions are idempotent and judge chain data only
// at a safe confirmation depth.
import type { Hex } from "viem";
import { adminDb, getConfig, getConfigOr, raiseAlert, rpc } from "./helpers.server";
import * as vrf from "./vrf.server";

type Batch = {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  chain_id: number;
  contract_address: string;
};
type Submission = {
  id: string;
  batch_id: string;
  tx_hash: string;
  signed_tx: string;
  from_address: string;
  nonce: number | string;
  status: string;
  last_broadcast_at: string | null;
  created_at: string;
};

/** The batch's config: the chain/contract captured on the batch, with the live RPC for that chain. */
async function cfgForBatch(
  batch: Pick<Batch, "chain_id" | "contract_address">,
): Promise<vrf.VrfConfig> {
  const live = await getConfig<vrf.VrfConfig>("vrf");
  if (live.chain_id !== batch.chain_id) {
    throw new Error(
      `Batch is on chain ${batch.chain_id} but vrf.rpc_url serves chain ${live.chain_id}; add the old RPC before changing chains`,
    );
  }
  return { ...live, contract: batch.contract_address };
}

/** Sign, persist, broadcast. Refunds ONLY if nothing was signed/persisted (proven pre-broadcast). */
export async function submitBatch(cfg: vrf.VrfConfig, batchId: string, spinIds: string[]) {
  let signed: vrf.SignedRequest;
  try {
    signed = await vrf.signRequest(cfg, spinIds);
  } catch (e) {
    await rpc("release_draw_prebroadcast", { _batch: batchId, _reason: (e as Error).message });
    throw new Error(
      `Couldn't start the Chainlink draw: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`,
    );
  }
  try {
    await rpc("record_draw_signed", {
      _batch: batchId,
      _from: signed.from,
      _nonce: signed.nonce,
      _tx_hash: signed.hash,
      _signed_tx: signed.serialized,
    });
  } catch (e) {
    // Persisting failed: the transaction was never sent, so the reservation can be released.
    await rpc("release_draw_prebroadcast", {
      _batch: batchId,
      _reason: `could not persist signed tx: ${(e as Error).message}`,
    }).catch(() => {});
    throw new Error(`Couldn't record the draw request: ${(e as Error).message}`);
  }
  const { error } = await vrf.broadcastRaw(cfg, signed.serialized);
  await rpc("record_draw_broadcast", { _tx_hash: signed.hash, _error: error });
  return { txHash: signed.hash, broadcastError: error };
}

/** Reconcile one open batch against the chain. Returns its status afterwards. */
export async function reconcileBatch(batch: Batch): Promise<string> {
  const db = await adminDb();
  const { data: subs, error } = await db
    .from("draw_submissions")
    .select("*")
    .eq("batch_id", batch.id)
    .order("created_at");
  if (error) throw new Error(error.message);
  const list = (subs ?? []) as Submission[];

  if (!list.length) {
    // Reserved but nothing was ever signed: if the server died mid-request, release after a grace period.
    if (batch.status === "reserved" && Date.now() - Date.parse(batch.created_at) > 2 * 60_000) {
      await rpc("release_draw_prebroadcast", {
        _batch: batch.id,
        _reason: "server interrupted before signing",
      });
      return "refunded";
    }
    return batch.status;
  }

  const cfg = await cfgForBatch(batch);
  const sub = list[list.length - 1]!;
  const st = await vrf.checkSubmission(cfg, sub);
  switch (st.state) {
    case "confirmed": {
      const out = await rpc<string>("confirm_draw_request", {
        _tx_hash: sub.tx_hash,
        _request_id: st.requestId.toString(),
        _block_number: Number(st.blockNumber),
        _block_hash: st.blockHash,
        _block_time: st.blockTime.toISOString(),
        _confirmations: st.confirmations,
        _event_spin_ids: st.spinIds,
      });
      return out === "conflict" ? "conflict" : "confirmed";
    }
    case "reverted":
      await rpc("record_draw_failed", {
        _tx_hash: sub.tx_hash,
        _outcome: "reverted",
        _block_number: Number(st.blockNumber),
        _block_hash: st.blockHash,
        _evidence: {},
      });
      return "reverted";
    case "dropped":
      await rpc("record_draw_failed", {
        _tx_hash: sub.tx_hash,
        _outcome: "dropped",
        _block_number: null,
        _block_hash: null,
        _evidence: st.evidence,
      });
      return "dropped";
    case "conflict":
      await raiseAlert(
        "request_mismatch",
        batch.id,
        "critical",
        "Confirmed request receipt is not a single SpinRequested request",
        st.evidence,
      );
      await (
        await adminDb()
      )
        .from("draw_coordination")
        .update({ requests_paused: true, pause_reason: `Receipt conflict on draw ${batch.id}` })
        .eq("id", true);
      return "conflict";
    case "not_found": {
      // Re-send the SAME signed transaction (idempotent for the network); never sign a new one.
      const last = sub.last_broadcast_at ? Date.parse(sub.last_broadcast_at) : 0;
      if (Date.now() - last > 20_000) {
        const { error: err } = await vrf.broadcastRaw(cfg, sub.signed_tx as Hex);
        await rpc("record_draw_broadcast", { _tx_hash: sub.tx_hash, _error: err });
      }
      return batch.status;
    }
    default:
      return batch.status;
  }
}

/** Settle every pending spin of the given confirmed batches from the chain (any player). */
export async function settleBatches(batchIds: string[]) {
  if (!batchIds.length) return { settled: 0 };
  const db = await adminDb();
  let settled = 0;
  for (const id of batchIds) {
    const { data: batch } = await db
      .from("draw_batches")
      .select("id, status, chain_id, contract_address, request_id")
      .eq("id", id)
      .maybeSingle();
    if (!batch || batch.status !== "confirmed") continue;
    const { data: pend } = await db
      .from("spins")
      .select("id")
      .eq("batch_id", id)
      .eq("status", "pending");
    const ids = ((pend ?? []) as { id: string }[]).map((r) => r.id);
    if (!ids.length) continue;
    const cfg = await cfgForBatch(batch);
    const res = await vrf.readSpinsAtSafeBlock(cfg, ids);
    for (const s of res.spins) {
      if (s.status !== vrf.ChainStatus.Fulfilled) continue;
      await rpc("settle_drawn_spin", {
        _spin: s.id,
        _prize_index: s.prizeIndex,
        _random_word: s.randomWord.toString(),
        _request_id: s.requestId.toString(),
        _fulfill_block: Number(res.blockNumber),
        _fulfill_block_hash: res.blockHash,
      });
      settled++;
    }
  }
  return { settled };
}

/** Reconcile + settle what one player is waiting on (fast path for the machine). */
export async function reconcileForUser(userId: string) {
  const db = await adminDb();
  const { data: open } = await db
    .from("draw_batches")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["reserved", "signed", "broadcast", "ambiguous"]);
  for (const b of (open ?? []) as Batch[]) await reconcileBatch(b);
  const { data: conf } = await db
    .from("spins")
    .select("batch_id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .not("batch_id", "is", null);
  const ids = [...new Set(((conf ?? []) as { batch_id: string }[]).map((r) => r.batch_id))];
  await settleBatches(ids);
}

import type { Json } from "@/integrations/supabase/types";
export type WorkerReport = { [key: string]: Json | undefined };

/** One pass of the protected scheduled worker. Independent of any browser. */
export async function runSettlement(): Promise<WorkerReport> {
  const db = await adminDb();
  const report: WorkerReport = { started_at: new Date().toISOString() };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      report[name] = (await fn()) as Json;
    } catch (e) {
      report[name] = { error: (e as Error).message };
      await raiseAlert("worker_error", name, "warning", `Settlement worker step "${name}" failed`, {
        error: (e as Error).message,
      });
    }
  };

  await step("advance_seasons", () => rpc("advance_seasons"));

  await step("reconcile", async () => {
    const { data } = await db
      .from("draw_batches")
      .select("*")
      .in("status", ["reserved", "signed", "broadcast", "ambiguous"])
      .order("created_at")
      .limit(25);
    const out: Record<string, string> = {};
    for (const b of (data ?? []) as Batch[]) out[b.id] = await reconcileBatch(b);
    return out;
  });

  await step("settle", async () => {
    const { data } = await db
      .from("spins")
      .select("batch_id")
      .eq("status", "pending")
      .not("batch_id", "is", null)
      .limit(500);
    const ids = [...new Set(((data ?? []) as { batch_id: string }[]).map((r) => r.batch_id))];
    return settleBatches(ids);
  });

  await step("legacy_pending", () => settleLegacyPending());
  await step("db_monitors", () => rpc("run_db_monitors"));
  await step("vrf_health", () => vrfHealthCheck());
  await step("snapshot_claims", async () =>
    (await import("./snapshot.server")).retryOpenClaims(50),
  );
  await step("x_shares", async () => (await import("./xverify.server")).retryPendingApiShares(25));

  report["finished_at"] = new Date().toISOString();
  await db
    .from("draw_coordination")
    .update({ worker_last_run_at: report["finished_at"], worker_last_report: report })
    .eq("id", true);
  return report;
}

/** Spins requested before batches existed (no batch row): settle from the chain if fulfilled. */
async function settleLegacyPending() {
  const db = await adminDb();
  const cfg = await getConfigOr<vrf.VrfConfig | null>("vrf", null);
  if (!cfg || vrf.vrfConfigProblem(cfg)) return { skipped: "vrf not configured" };
  const { data } = await db
    .from("spins")
    .select("id, contract_address, created_at, vrf_request_id")
    .eq("status", "pending")
    .is("batch_id", null)
    .limit(50);
  const rows = (data ?? []) as {
    id: string;
    contract_address: string | null;
    created_at: string;
    vrf_request_id: string | null;
  }[];
  let settled = 0;
  for (const r of rows) {
    const c = { ...cfg, contract: r.contract_address ?? cfg.contract };
    const res = await vrf.readSpinsAtSafeBlock(c, [r.id]);
    const s = res.spins[0]!;
    if (s.status === vrf.ChainStatus.Fulfilled) {
      await rpc("settle_drawn_spin", {
        _spin: r.id,
        _prize_index: s.prizeIndex,
        _random_word: s.randomWord.toString(),
        _request_id: s.requestId.toString(),
        _fulfill_block: Number(res.blockNumber),
        _fulfill_block_hash: res.blockHash,
      });
      settled++;
    } else if (Date.now() - Date.parse(r.created_at) > 30 * 60_000) {
      await raiseAlert(
        "stuck_draw",
        r.id,
        "critical",
        "A pre-season spin is still pending on-chain; it stays reserved (never refunded on timeout)",
        { status: s.status },
      );
    }
  }
  return { checked: rows.length, settled };
}

/** Coordinator unchanged, subscription funded, consumer registered; chain vs DB inventory. */
async function vrfHealthCheck() {
  const cfg = await getConfigOr<vrf.VrfConfig | null>("vrf", null);
  if (!cfg || vrf.vrfConfigProblem(cfg)) return { skipped: "vrf not configured" };
  const db = await adminDb();
  const h = await vrf.readVrfHealth(cfg);
  const out: Record<string, unknown> = { ...h };
  if (cfg.coordinator && h.coordinator !== cfg.coordinator.toLowerCase()) {
    await raiseAlert(
      "vrf_coordinator_changed",
      cfg.contract,
      "critical",
      "The contract's VRF coordinator differs from vrf.coordinator — draws paused",
      { expected: cfg.coordinator, actual: h.coordinator },
    );
    await db
      .from("draw_coordination")
      .update({ requests_paused: true, pause_reason: "VRF coordinator changed" })
      .eq("id", true);
  }
  if (!h.isConsumer)
    await raiseAlert(
      "vrf_not_consumer",
      cfg.contract,
      "critical",
      "The draw contract is not a consumer of its VRF subscription",
      {},
    );
  const min = BigInt(cfg.min_subscription_balance ?? "0");
  const bal = BigInt(h.nativePayment ? h.nativeBalance : h.balance);
  if (bal <= min) {
    await raiseAlert(
      "vrf_funding",
      cfg.contract,
      "critical",
      "VRF subscription balance is at or below the configured minimum",
      { balance: bal.toString(), minimum: min.toString(), native: h.nativePayment },
    );
  }
  // Inventory drift (only meaningful when nothing is pending).
  const { count: pending } = await db
    .from("spins")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (!pending) {
    const chain = await vrf.readPool(cfg);
    const { data: prizes } = await db
      .from("prizes")
      .select("id, name, inventory, onchain_index")
      .not("onchain_index", "is", null);
    for (const p of (prizes ?? []) as {
      id: string;
      name: string;
      inventory: number | null;
      onchain_index: number;
    }[]) {
      const c = chain.pool[p.onchain_index];
      if (!c || p.inventory == null) continue;
      if (c.remaining !== vrf.UNLIMITED && c.remaining !== p.inventory) {
        await raiseAlert(
          "inventory_drift",
          p.id,
          "warning",
          `Stock for ${p.name}: database ${p.inventory}, chain ${c.remaining}`,
          { db: p.inventory, chain: c.remaining },
        );
      }
    }
    out["pool_version"] = chain.version.toString();
  }
  return out;
}
