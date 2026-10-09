// Gotcha machine: readiness/odds, draws (Chainlink VRF), public spin pages, and admin draw controls.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type SpinOutRow = {
  id: string;
  status: string;
  created_at: string;
  prize_id: string | null;
  prize_name: string | null;
  rarity: string | null;
  points: number | string | null;
  participation_points: string | null;
  bonus_points: string | null;
  seasonal_eligible: boolean | null;
  random_word: string | null;
  request_tx: string | null;
  refund_reason: string | null;
};

function publicSpin(r: SpinOutRow, verifyUrl: string | undefined) {
  return {
    id: r.id,
    status: r.status as "pending" | "fulfilled" | "refunded",
    prize_id: r.prize_id,
    prize_name: r.prize_name,
    rarity: r.rarity,
    // Seasonal points earned by this spin (participation + bonus), as exact strings.
    participation_points: String(r.participation_points ?? "0"),
    bonus_points: String(r.bonus_points ?? "0"),
    points: Number(BigInt(r.participation_points ?? "0") + BigInt(r.bonus_points ?? "0")),
    seasonal: !!r.seasonal_eligible,
    random_word: r.random_word,
    request_tx: r.request_tx,
    refund_reason: r.refund_reason,
    verify_url: verifyUrl,
  };
}

/**
 * Narrow readiness + published odds for the machine (replaces the client's direct vrf config read,
 * which RLS hides from ordinary players). Public: odds and season scoring are published anyway.
 */
export const getMachineReadiness = createServerFn({ method: "GET" }).handler(async () => {
  const h = await import("./helpers.server");
  const v = await import("./vrf.server");
  const r = await import("./seasonRules");
  const db = await h.adminDb();
  const cfg = await h.getConfigOr<import("./vrf.server").VrfConfig | null>("vrf", null);
  const problem = v.vrfConfigProblem(cfg);
  const { data: coord } = await db.from("draw_coordination").select("requests_paused, pause_reason, pool_publishing").eq("id", true).maybeSingle();
  const { data: prizes, error } = await db.from("prizes").select("id, name, rarity, weight, inventory, active, onchain_index").order("onchain_index", { nullsFirst: false });
  if (error) throw new Error(error.message);
  const { data: season } = await db.rpc("current_season");
  const s = season && (season as { id: string | null }).id ? (season as { id: string; slug: string; name: string; ends_at: string; rules: import("./seasonRules").SeasonRules }) : null;
  const projection = s ? r.projectPerSpin(s.rules, (prizes ?? []) as import("./seasonRules").PoolPrize[]) : null;
  let reason: string | null = problem;
  if (!reason && coord?.requests_paused) reason = `Draws are paused: ${coord.pause_reason ?? "maintenance"}`;
  if (!reason && coord?.pool_publishing) reason = "Prize odds are being published. Try again in a minute.";
  return {
    open: !reason,
    reason,
    season: s ? { slug: s.slug, name: s.name, ends_at: s.ends_at } : null,
    projection,
    pool: ((prizes ?? []) as import("./seasonRules").PoolPrize[]).filter((p) => p.active && p.onchain_index != null),
  };
});

export const startDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ count: z.number().int().min(1).max(10), idempotencyKey: z.string().min(8).max(80) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const v = await import("./vrf.server");
    const st = await import("./settlement.server");
    const cfg = v.requireVrf(await h.getConfig("vrf"));
    if (data.count > (cfg.max_batch ?? 5)) throw new Error(`Up to ${cfg.max_batch ?? 5} capsules per pull`);
    const db = await h.adminDb();

    // Finish anything this player left in flight first.
    await st.reconcileForUser(context.userId);

    // The odds shown in the app must be the odds the contract will use.
    const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
    const chain = await v.readPool(cfg);
    if (chain.paused) throw new Error("Draws are paused on-chain.");
    if (!v.weightsMatch(v.poolArrays(prizes ?? []), chain.pool)) throw new Error("Prize odds are being updated on-chain. Try again in a minute.");

    const res = await h.rpc<{ batch_id: string; replayed: boolean; status: string; spin_ids: string[] }>("reserve_draw_batch", {
      _user: context.userId,
      _count: data.count,
      _idempotency_key: data.idempotencyKey,
      _chain_id: cfg.chain_id,
      _contract: cfg.contract,
      _pool_version: chain.version.toString(),
    });
    let txHash: string | null = null;
    if (!res.replayed || res.status === "reserved") {
      const sent = await st.submitBatch(cfg, res.batch_id, res.spin_ids);
      txHash = sent.txHash;
      await h.audit(context.userId, "spin.requested", { batch: res.batch_id, spinIds: res.spin_ids, tx: sent.txHash, broadcastError: sent.broadcastError });
    } else {
      const { data: b } = await db.from("draw_batches").select("request_tx").eq("id", res.batch_id).maybeSingle();
      txHash = b?.request_tx ?? null;
    }
    // Fast path: try to confirm now; the worker finishes it otherwise (even if the browser closes).
    try {
      for (let i = 0; i < 6; i++) {
        const { data: b } = await db.from("draw_batches").select("*").eq("id", res.batch_id).single();
        if (!["signed", "broadcast", "ambiguous", "reserved"].includes(b.status)) break;
        await st.reconcileBatch(b);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn("[startDraw] fast reconcile failed; the worker will retry", (e as Error).message);
    }
    return { spinIds: res.spin_ids, txHash: txHash ?? "", txUrl: v.txUrl(cfg, txHash) };
  });

export const checkDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const v = await import("./vrf.server");
    const st = await import("./settlement.server");
    const cfg = await h.getConfigOr<import("./vrf.server").VrfConfig>("vrf", { enabled: false, chain_id: 0, rpc_url: "", contract: "" });
    const db = await h.adminDb();
    const cols = "id, status, created_at, request_tx, prize_id, prize_name, rarity, points, participation_points, bonus_points, seasonal_eligible, random_word, refund_reason";
    const load = async () => {
      const { data: rows, error } = await db.from("spins").select(cols).eq("user_id", context.userId).in("id", data.ids);
      if (error) throw new Error(error.message);
      return (rows ?? []) as SpinOutRow[];
    };
    let rows = await load();
    if (rows.some((r) => r.status === "pending")) {
      try {
        await st.reconcileForUser(context.userId);
      } catch (e) {
        console.warn("[checkDraw] reconcile failed; will retry", (e as Error).message);
      }
      rows = await load();
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return data.ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [publicSpin(r, v.txUrl(cfg, r.request_tx))] : [];
    });
  });

/** Public result page data for a shared spin (no wallets, emails or auth ids). */
export const getPublicSpin = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const { data: s } = await db
      .from("spins")
      .select("id, status, prize_name, rarity, participation_points, bonus_points, seasonal_eligible, fulfilled_at, request_tx, random_word, user_id, season_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!s || s.status !== "fulfilled") return null;
    const [{ data: p }, { data: season }] = await Promise.all([
      db.from("profiles").select("public_id, public_alias, avatar_key").eq("id", s.user_id).maybeSingle(),
      s.season_id ? db.from("seasons").select("name, slug").eq("id", s.season_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return {
      id: s.id as string,
      prize_name: s.prize_name as string,
      rarity: s.rarity as string,
      participation_points: String(s.participation_points ?? "0"),
      bonus_points: String(s.bonus_points ?? "0"),
      seasonal: !!s.seasonal_eligible,
      fulfilled_at: s.fulfilled_at as string,
      random_word: s.random_word as string | null,
      request_tx: s.request_tx as string | null,
      player: { public_id: p?.public_id ?? null, alias: p?.public_alias ?? null, avatar_key: p?.avatar_key ?? null },
      season: season ? { name: season.name, slug: season.slug } : null,
    };
  });

// ---------------------------------------------------------------- admin

export const adminVrfStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const v = await import("./vrf.server");
    const cfg = await h.getConfigOr<import("./vrf.server").VrfConfig | null>("vrf", null);
    const db = await h.adminDb();
    const [{ data: prizes }, { count: pendingDb }, { data: coord }, { data: openBatches }, { data: lastPub }] = await Promise.all([
      db.from("prizes").select("id, name, weight, inventory, active, onchain_index"),
      db.from("spins").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("draw_coordination").select("*").eq("id", true).maybeSingle(),
      db.from("draw_batches").select("id, status, created_at, spin_count, request_tx, last_error").in("status", ["reserved", "signed", "broadcast", "ambiguous"]).order("created_at"),
      db.from("prize_pool_publications").select("*").order("id", { ascending: false }).limit(1),
    ]);
    const local = v.poolArrays(prizes ?? []);
    const unpublished = ((prizes ?? []) as { onchain_index: number | null; active: boolean }[]).filter((p) => p.onchain_index == null && p.active).length;
    const base = { coordination: coord, openBatches: openBatches ?? [], lastPublication: lastPub?.[0] ?? null, pendingDb: pendingDb ?? 0, unpublished };
    if (!cfg || !/^0x[0-9a-fA-F]{40}$/.test(cfg.contract ?? "")) return { configured: false as const, enabled: !!cfg?.enabled, ...base };
    const chain = await v.readPool(cfg);
    let health: Record<string, string | boolean> = {};
    try {
      health = await v.readVrfHealth(cfg);
    } catch (e) {
      health = { error: (e as Error).message };
    }
    return {
      configured: true as const,
      enabled: !!cfg.enabled,
      contract: cfg.contract,
      contractUrl: cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/address/${cfg.contract}` : undefined,
      poolVersion: chain.version.toString(),
      pendingOnChain: chain.pending,
      chainPaused: chain.paused,
      oddsInSync: unpublished === 0 && v.weightsMatch(local, chain.pool),
      chainPool: chain.pool,
      health,
      ...base,
    };
  });

/** Publish weights + stock to the contract, coordinated with draw submission (no draw in flight). */
export const adminPublishPool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const v = await import("./vrf.server");
    const cfg = await h.getConfig<import("./vrf.server").VrfConfig>("vrf");
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg?.contract ?? "")) throw new Error("Set vrf.contract in Configuration first");
    const chain = await v.readPool(cfg);
    if (chain.pending > 0) throw new Error("The contract still has pending requests; wait for Chainlink to fulfil them");
    const plan = await h.rpc<{ publication_id: number; weights: number[]; remaining: (number | string)[] }>("begin_pool_publication", {
      _chain_id: cfg.chain_id,
      _contract: cfg.contract,
      _chain_remaining: chain.pool.map((p) => p.remaining),
      _actor: context.userId,
    });
    try {
      const out = await v.publishPoolOnChain(cfg, plan.weights.map(Number), plan.remaining.map(Number));
      await h.rpc("finish_pool_publication", { _publication: plan.publication_id, _ok: true, _tx_hash: out.hash, _pool_version: out.version.toString(), _error: null });
      await h.audit(context.userId, "vrf.pool_published", { tx: out.hash, version: out.version.toString(), weights: plan.weights, remaining: plan.remaining });
      return { txHash: out.hash as string, txUrl: v.txUrl(cfg, out.hash), version: out.version.toString() };
    } catch (e) {
      // Leave the publication open (draws stay locked) — the tx may still land. Reconcile it explicitly.
      await h.raiseAlert("pool_publication", String(plan.publication_id), "critical", "Prize pool publication did not confirm; draws stay locked until reconciled", { error: (e as Error).message });
      throw new Error(`Publication not confirmed: ${(e as Error).message}. Use “Reconcile publication” once the transaction settles.`);
    }
  });

/** After an unconfirmed publication: compare the chain pool with the plan and close it out. */
export const adminReconcilePublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const v = await import("./vrf.server");
    const cfg = await h.getConfig<import("./vrf.server").VrfConfig>("vrf");
    const db = await h.adminDb();
    const { data: pubs } = await db.from("prize_pool_publications").select("*").eq("status", "publishing").order("id", { ascending: false }).limit(1);
    const pub = pubs?.[0];
    if (!pub) return { ok: true, note: "Nothing to reconcile" };
    const chain = await v.readPool(cfg);
    const landed = chain.pool.length === pub.weights.length && chain.pool.every((p, i) => p.weight === Number(pub.weights[i]) && p.remaining === Number(pub.remaining[i]));
    await h.rpc("finish_pool_publication", { _publication: pub.id, _ok: landed, _tx_hash: pub.tx_hash, _pool_version: landed ? chain.version.toString() : null, _error: landed ? null : "Chain pool does not match the plan; publish again" });
    if (landed) await h.rpc("resolve_alert", { _kind: "pool_publication", _subject: String(pub.id), _actor: context.userId });
    await h.audit(context.userId, "vrf.publication_reconciled", { id: pub.id, landed });
    return { ok: landed };
  });

export const adminRunSettlement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const st = await import("./settlement.server");
    const report = await st.runSettlement();
    await h.audit(context.userId, "worker.run_manual", report);
    return report;
  });

export const adminSetDrawPause = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ paused: z.boolean(), reason: z.string().max(200).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const db = await h.adminDb();
    const { error } = await db.from("draw_coordination").update({ requests_paused: data.paused, pause_reason: data.paused ? data.reason ?? "Paused by admin" : null, updated_at: new Date().toISOString() }).eq("id", true);
    if (error) throw new Error(error.message);
    await h.audit(context.userId, data.paused ? "draws.paused" : "draws.resumed", data);
    return { ok: true };
  });
