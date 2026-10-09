// The protected settlement worker: runs for every player, independent of any browser.
// Schedule POST /api/cron/settle (Authorization: Bearer LOVABLE_CRON_SECRET) every minute.
import { serviceDb, readConfig, drawDeps } from "./server-context.server";
import type { VrfConfig } from "./vrf.server";

export async function runWorker() {
  const report: Record<string, unknown> = { at: new Date().toISOString() };
  const db = await serviceDb();
  const vrfCfg = await readConfig<VrfConfig>("vrf").catch(() => null);

  // 1) Draws: confirm requests, resend stored transactions, settle fulfilled spins.
  if (vrfCfg) {
    const draws = await import("./draws.server");
    report["draws"] = await draws
      .runSettlementPass(await drawDeps(vrfCfg))
      .catch((e: Error) => ({ error: e.message }));
    // 2) VRF subscription funding.
    const vrf = await import("./vrf.server");
    if (vrf.isAddress(vrfCfg.contract)) {
      try {
        const sub = await vrf.readSubscription(vrf.vrfPublic(vrfCfg), vrfCfg.contract);
        const min = BigInt(vrfCfg.min_subscription_balance ?? "0");
        report["subscription"] = sub;
        if (!sub.isConsumer || BigInt(sub.balance) <= min) {
          await db.rpc("raise_ops_alert", {
            _key: `vrf_funding:${vrfCfg.contract.toLowerCase()}`,
            _kind: "vrf_funding",
            _severity: "critical",
            _message: sub.isConsumer
              ? `VRF subscription ${sub.subId} balance ${sub.balance} is at or below the alert threshold`
              : "The draw contract is not a consumer of its VRF subscription",
            _details: sub,
          });
        }
      } catch (e) {
        await db.rpc("raise_ops_alert", {
          _key: "vrf_funding:unreadable",
          _kind: "vrf_funding",
          _severity: "warning",
          _message: `Couldn't read the VRF subscription: ${(e as Error).message.slice(0, 200)}`,
          _details: {},
        });
      }
    }
  } else {
    await db.rpc("advance_season_states", {});
  }

  // 3) Snapshot claims that are pending or were unavailable (archive RPC outage) — retried, never guessed.
  try {
    const snap = await import("./snapshot.server");
    const admin = (await import("./server-context.server")).adminClient;
    const r = await admin();
    const { data: open } = await r
      .from("nft_snapshot_claims")
      .select("id, collection_id, token_id, owner_address")
      .in("status", ["pending", "unavailable"])
      .order("requested_at")
      .limit(200);
    const cfg = await readConfig<{ archive_rpc_by_chain?: Record<string, string> }>(
      "snapshots",
    ).catch(() => ({}) as { archive_rpc_by_chain?: Record<string, string> });
    const groups = new Map<
      string,
      { id: string; collection_id: string; token_id: string; owner_address: string }[]
    >();
    for (const c of (open ?? []) as {
      id: string;
      collection_id: string;
      token_id: string;
      owner_address: string;
    }[])
      groups.set(c.collection_id, [...(groups.get(c.collection_id) ?? []), c]);
    const out = { verified: 0, rejected: 0, unavailable: 0 };
    for (const [cid, claims] of groups) {
      const [col] = await db.select<import("./snapshot.server").Collection>("nft_collections", {
        id: cid,
      });
      if (!col) continue;
      const res = await snap.verifyClaims(
        db,
        snap.archiveClient(col.chain_id, cfg.archive_rpc_by_chain),
        col,
        claims,
      );
      out.verified += res.verified;
      out.rejected += res.rejected;
      out.unavailable += res.unavailable;
    }
    report["snapshot_claims"] = out;
  } catch (e) {
    report["snapshot_claims"] = { error: (e as Error).message };
  }

  // 4) Monitors.
  report["open_alerts"] = (await db.rpc("ops_monitor_scan", {}).catch(() => [])).length;
  return report;
}
