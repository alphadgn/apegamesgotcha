import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The generated database types can briefly lag behind applied migrations.
  return supabaseAdmin as any;
}

async function getConfig(key: string) {
  const db = await admin();
  const { data, error } = await db.from("app_config").select("value").eq("key", key).single();
  if (error) throw new Error(`Missing config: ${key}`);
  return data.value as any;
}

async function audit(actor: string, action: string, details: unknown) {
  const db = await admin();
  await db.from("audit_log").insert({ actor, action, details: details as any });
}

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden");
}

// ---------- Wallet linking ----------
export const getWalletNonce = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const nonce = crypto.randomUUID();
    const db = await admin();
    await db.from("wallet_nonces").upsert({ user_id: context.userId, nonce, created_at: new Date().toISOString() });
    return { message: `ApeGames Gotcha wallet verification\nUser: ${context.userId}\nNonce: ${nonce}` };
  });

export const linkWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/), signature: z.string().startsWith("0x") }).parse(d))
  .handler(async ({ data, context }) => {
    const { verifyMessage } = await import("viem");
    const db = await admin();
    const { data: row } = await db.from("wallet_nonces").select("nonce, created_at").eq("user_id", context.userId).single();
    if (!row) throw new Error("Request a new signature first");
    if (Date.now() - new Date(row.created_at).getTime() > 10 * 60_000) throw new Error("Signature request expired");
    const message = `ApeGames Gotcha wallet verification\nUser: ${context.userId}\nNonce: ${row.nonce}`;
    const ok = await verifyMessage({ address: data.address as `0x${string}`, message, signature: data.signature as `0x${string}` });
    if (!ok) throw new Error("Signature does not match wallet");
    const address = data.address.toLowerCase();
    const { data: existing } = await db.from("wallets").select("user_id").eq("address", address).maybeSingle();
    if (existing && existing.user_id !== context.userId) throw new Error("Wallet already linked to another account");
    if (!existing) {
      const { count } = await db.from("wallets").select("id", { count: "exact", head: true }).eq("user_id", context.userId).eq("is_default", true);
      await db.from("wallets").insert({ user_id: context.userId, address, kind: "external", is_default: !count });
    }
    await db.from("wallet_nonces").delete().eq("user_id", context.userId);
    await audit(context.userId, "wallet.linked", { address });
    return { address };
  });

// ---------- NFT sync & holding points ----------
export const syncNfts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listOwnedTokens, fetchLevel } = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const scoring = await getConfig("scoring");
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    let found = 0;
    let awarded = 0;
    for (const w of wallets ?? []) {
      const ids = await listOwnedTokens(cfg, w.address);
      for (const id of ids) {
        found++;
        const tokenId = id.toString();
        const { data: prev } = await db.from("nft_holdings").select("level, level_override").eq("token_id", tokenId).maybeSingle();
        const level = prev?.level ?? (await fetchLevel(cfg, id));
        await db.from("nft_holdings").upsert({ token_id: tokenId, owner_address: w.address, user_id: context.userId, level, synced_at: new Date().toISOString() });
        const eff = prev?.level_override ?? level;
        const pts = Number(scoring.level_weights?.[String(eff)] ?? scoring.default_level_weight ?? 0);
        if (pts > 0) {
          const { error } = await db.from("points_ledger").insert({ user_id: context.userId, amount: pts, reason: "holding", ref: tokenId });
          if (!error) awarded += pts;
        }
      }
    }
    await audit(context.userId, "nft.synced", { found, awarded });
    return { found, awarded };
  });

// ---------- Burn for spin ----------
export const claimBurn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), tokenId: z.string().regex(/^\d+$/) }).parse(d))
  .handler(async ({ data, context }): Promise<{ status: "pending" | "credited" }> => {
    const { verifyBurnTx, fetchLevel, BurnPendingError } = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const txHash = data.txHash.toLowerCase();
    // Already credited (e.g. the page retried after a slow network)?
    const { data: done } = await db.from("burn_claims").select("user_id").eq("tx_hash", txHash).eq("token_id", data.tokenId).maybeSingle();
    if (done) {
      if (done.user_id !== context.userId) throw new Error("This NFT or transaction was already claimed");
      return { status: "credited" };
    }
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    if (!wallets?.length) throw new Error("Link a wallet first");
    try {
      await verifyBurnTx(cfg, txHash as `0x${string}`, BigInt(data.tokenId), wallets.map((w: { address: string }) => w.address));
    } catch (e) {
      if (e instanceof BurnPendingError) return { status: "pending" };
      throw e;
    }
    const { data: h } = await db.from("nft_holdings").select("level, level_override").eq("token_id", data.tokenId).maybeSingle();
    const level = h?.level_override ?? h?.level ?? (await fetchLevel(cfg, BigInt(data.tokenId)));
    if (level == null) throw new Error("Could not read this NFT's level. Ask an admin to verify it.");
    if (level < Number(cfg.burn_min_level)) throw new Error(`Only Level ${cfg.burn_min_level}+ NFTs are eligible`);
    const { error } = await db.from("burn_claims").insert({ user_id: context.userId, token_id: data.tokenId, tx_hash: txHash, level });
    if (error) throw new Error("This NFT or transaction was already claimed");
    // The claim and the spin go together: if the spin can't be added, the claim is undone so it can be retried.
    const { error: creditError } = await db.from("spin_credits").insert({ user_id: context.userId, source: "burn", ref: data.tokenId });
    if (creditError) {
      await db.from("burn_claims").delete().eq("tx_hash", txHash).eq("token_id", data.tokenId);
      throw new Error(`Burn verified, but the free spin couldn't be added (${creditError.message}). Try again.`);
    }
    await db.from("nft_holdings").upsert({ token_id: data.tokenId, owner_address: cfg.burn_address.toLowerCase(), user_id: context.userId, level, burned: true });
    await audit(context.userId, "nft.burned", { ...data, level });
    return { status: "credited" };
  });

/** What the burn window needs (public NFT settings, no secrets). */
export const getNftSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const cfg = await getConfig("nft");
    return {
      contract: String(cfg.contract ?? ""),
      chain_id: Number(cfg.chain_id ?? 33139),
      rpc_url: String(cfg.rpc_url ?? ""),
      explorer_url: String(cfg.explorer_url ?? "https://apescan.io"),
      burn_address: String(cfg.burn_address ?? ""),
      burn_min_level: Number(cfg.burn_min_level ?? 4),
    };
  });

// ---------- Spins (Chainlink VRF) ----------
// The prize is drawn on-chain by the GotchaVRF contract. The server reserves credits,
// sends the request, and records whatever the contract drew. It never generates randomness.

type SpinRow = { id: string; status: string; created_at: string; request_tx: string | null };
type PrizeRow = { id: string; weight: number; inventory: number | null; active: boolean; onchain_index: number | null; created_at?: string };

async function settleSpins(cfg: import("./vrf.server").VrfConfig, rows: SpinRow[]) {
  const pending = rows.filter((r) => r.status === "pending");
  if (!pending.length) return;
  const { readSpins, ChainStatus } = await import("./vrf.server");
  const db = await admin();
  const onchain = await readSpins(cfg, pending.map((r) => r.id));
  const timeoutMs = (cfg.draw_timeout_sec ?? 900) * 1000;
  for (const s of onchain) {
    const row = pending.find((r) => r.id === s.id);
    if (!row) continue;
    if (s.status === ChainStatus.Fulfilled) {
      const { error } = await db.rpc("finalize_spin", {
        _spin_id: s.id,
        _prize_index: s.prizeIndex,
        _random_word: s.randomWord.toString(),
        _request_id: s.requestId.toString(),
      });
      if (error) throw new Error(error.message);
    } else if (s.status === ChainStatus.Cancelled) {
      await db.rpc("refund_spins", { _ids: [s.id] });
    } else if (s.status === ChainStatus.None && Date.now() - new Date(row.created_at).getTime() > timeoutMs) {
      // The request never reached the contract — give the credit back.
      await db.rpc("refund_spins", { _ids: [s.id] });
    }
  }
}

type SpinOutRow = {
  id: string;
  status: string;
  created_at: string;
  prize_id: string | null;
  prize_name: string | null;
  rarity: string | null;
  points: number | null;
  random_word: string | null;
  request_tx: string | null;
};

function publicSpin(r: SpinOutRow, verifyUrl: string | undefined) {
  return {
    id: r.id,
    status: r.status as "pending" | "fulfilled" | "refunded",
    prize_id: r.prize_id,
    prize_name: r.prize_name,
    rarity: r.rarity,
    points: r.points,
    random_word: r.random_word,
    request_tx: r.request_tx,
    verify_url: verifyUrl,
  };
}

export const startDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ count: z.number().int().min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const vrf = await import("./vrf.server");
    const cfg = vrf.requireVrf((await getConfig("vrf")) as import("./vrf.server").VrfConfig);
    if (data.count > (cfg.max_batch ?? 5)) throw new Error(`Up to ${cfg.max_batch ?? 5} capsules per pull`);
    const db = await admin();

    // Settle anything this user left in flight first.
    const { data: open } = await db.from("spins").select("id, status, created_at, request_tx").eq("user_id", context.userId).eq("status", "pending");
    if (open?.length) await settleSpins(cfg, open);

    // The odds shown in the app must be the odds the contract will use.
    const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
    const chain = await vrf.readPool(cfg);
    if (!vrf.weightsMatch(vrf.poolArrays(prizes ?? []), chain.pool)) throw new Error("Prize odds are being updated on-chain. Try again in a minute.");

    const { data: ids, error } = await db.rpc("begin_spins", { _user_id: context.userId, _count: data.count });
    if (error) throw new Error(error.message);
    const spinIds = ids as unknown as string[];

    let sent;
    try {
      sent = await vrf.requestSpinsOnChain(cfg, spinIds);
    } catch (e) {
      await db.rpc("refund_spins", { _ids: spinIds });
      throw new Error(`Couldn't start the Chainlink draw: ${(e as Error).message}`);
    }
    await db.from("spins").update({
      request_tx: sent.hash,
      vrf_request_id: sent.requestId.toString(),
      chain_id: cfg.chain_id,
      contract_address: cfg.contract.toLowerCase(),
    }).in("id", spinIds);
    if (sent.reverted) {
      await db.rpc("refund_spins", { _ids: spinIds });
      throw new Error("The Chainlink draw request was rejected on-chain. Your spins were returned.");
    }
    await audit(context.userId, "spin.requested", { spinIds, tx: sent.hash, requestId: sent.requestId.toString() });
    return { spinIds, txHash: sent.hash as string, txUrl: vrf.txUrl(cfg, sent.hash) };
  });

export const checkDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const { txUrl } = await import("./vrf.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const db = await admin();
    const cols = "id, status, created_at, request_tx, prize_id, prize_name, rarity, points, random_word";
    const load = async () => {
      const { data: rows } = await db.from("spins").select(cols).eq("user_id", context.userId).in("id", data.ids);
      return (rows ?? []) as SpinOutRow[];
    };
    let rows = await load();
    if (rows.some((r: SpinOutRow) => r.status === "pending")) {
      await settleSpins(cfg, rows);
      rows = await load();
    }
    const byId = new Map<string, SpinOutRow>(rows.map((r: SpinOutRow) => [r.id, r]));
    return data.ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [publicSpin(r, txUrl(cfg, r.request_tx))] : [];
    });
  });

// ---------- Admin ----------
export const adminUpdateConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ key: z.string().min(1), value: z.record(z.any()) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { error } = await db.from("app_config").upsert({ key: data.key, value: data.value, updated_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context.userId, "config.updated", data);
    return { ok: true };
  });

export const adminDeletePrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: p } = await db.from("prizes").select("name, onchain_index").eq("id", data.id).maybeSingle();
    if (!p) throw new Error("Prize not found");
    const [{ count: real }, { count: demo }] = await Promise.all([
      db.from("spins").select("id", { count: "exact", head: true }).eq("prize_id", data.id),
      db.from("demo_spins").select("id", { count: "exact", head: true }).eq("prize_id", data.id),
    ]);
    // Prizes already won or published on-chain stay on record (history + draw mapping); switch them off instead.
    if ((real ?? 0) > 0 || (demo ?? 0) > 0 || p.onchain_index != null) {
      const { error } = await db.from("prizes").update({ active: false }).eq("id", data.id);
      if (error) throw new Error(error.message);
      await db.from("audit_log").insert({ actor: context.userId, action: "admin.prize_deactivated", details: { id: data.id, name: p.name } });
      return { deleted: false };
    }
    const { error } = await db.from("prizes").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    await db.from("audit_log").insert({ actor: context.userId, action: "admin.prize_deleted", details: { id: data.id, name: p.name } });
    return { deleted: true };
  });

export const adminUpsertPrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().min(1).max(100),
      rarity: z.enum(["common", "rare", "epic", "legendary"]),
      weight: z.number().int().min(0),
      points: z.number().int(),
      inventory: z.number().int().min(0).nullable(),
      active: z.boolean(),
      image_url: z.string().max(500).nullable().optional(),
      is_physical: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { id, ...rest } = data;
    const { error } = id
      ? await db.from("prizes").update(rest).eq("id", id)
      : await db.from("prizes").insert(rest);
    if (error) throw new Error(error.message);
    await audit(context.userId, "prize.upserted", data);
    return { ok: true };
  });

export const adminGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email(),
        spins: z.number().int().min(0).max(100),
        /** real = paid-equivalent on-chain spin; demo = practice spin (no prizes or points). */
        kind: z.enum(["real", "demo"]),
        points: z.number().int(),
        note: z.string().max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const user = await userByEmail(db, data.email);
    if (!user) throw new Error("No user with that email");
    if (data.spins > 0) {
      const { grantSpins } = await import("./grants.server");
      await grantSpins(db, { userId: user.id, count: data.spins, kind: data.kind, note: data.note, actor: context.userId });
    }
    if (data.points !== 0) {
      const { error } = await db.from("points_ledger").insert({ user_id: user.id, amount: data.points, reason: "admin_adjustment", created_by: context.userId });
      if (error) throw new Error(`Couldn't adjust points: ${error.message}`);
      await audit(context.userId, "admin.points", { user_id: user.id, points: data.points, note: data.note });
    }
    return { ok: true };
  });

async function userByEmail(db: any, email: string): Promise<{ id: string; email?: string } | undefined> {
  const want = email.trim().toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Couldn't look up players: ${error.message}`);
    const users = (data?.users ?? []) as { id: string; email?: string }[];
    const hit = users.find((u) => u.email?.toLowerCase() === want);
    if (hit || users.length < 1000) return hit;
  }
  return undefined;
}

export type SpinGrantRow = import("./grants.server").SpinGrantRow;

/** Every admin spin grant with how many of its spins have been used, newest first. */
export const adminListGrants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { listGrants } = await import("./grants.server");
    return listGrants(await admin());
  });

/** The signed-in player's spins: real (on-chain draws) and demo (granted practice spins). */
export const getMySpinBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { spinBalance } = await import("./grants.server");
    return spinBalance(await admin(), context.userId);
  });

/** Play demo spins for a signed-in player (granted first, then the free one). Results count on the demo board. */
export const playDemoSpins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ count: z.number().int().min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const g = await import("./grants.server");
    return g.playDemoSpins(await admin(), context.userId, data.count);
  });

export const adminDeleteGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const g = await import("./grants.server");
    return { removed: await g.deleteGrant(await admin(), data.grantId, context.userId) };
  });

/** Public leaderboard: "live" (real on-chain spins) or "demo" (signed-in players' demo spins). */
export const adminSetLeaderboardMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ mode: z.enum(["demo", "live"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    await mergeConfig("leaderboard", { mode: data.mode });
    await audit(context.userId, "leaderboard.mode", { mode: data.mode });
    return { mode: data.mode };
  });

/** Real prizes won (Chainlink draws), newest first, with who won them and whether they've been handed over. */
export const adminListWinners = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ minRarity: z.enum(["all", "rare", "epic", "legendary"]).default("rare") }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const rarities = { all: null, rare: ["rare", "epic", "legendary"], epic: ["epic", "legendary"], legendary: ["legendary"] }[data.minRarity];
    let q = db.from("spins").select("*").eq("status", "fulfilled").order("created_at", { ascending: false }).limit(500);
    if (rarities) q = q.in("rarity", rarities);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const vrf = (await getConfig("vrf")) as { explorer_url?: string };
    const emails = new Map<string, string>();
    for (const id of new Set(((rows ?? []) as { user_id: string }[]).map((r) => r.user_id))) {
      const { data: u } = await db.auth.admin.getUserById(id);
      emails.set(id, u?.user?.email ?? id);
    }
    type W = { id: string; user_id: string; created_at: string; fulfilled_at?: string | null; prize_name: string; rarity: string; points: number; delivered_at?: string | null; request_tx?: string | null };
    return ((rows ?? []) as W[]).map((r) => ({
      id: r.id as string,
      at: r.fulfilled_at ?? r.created_at,
      player: emails.get(r.user_id) ?? r.user_id,
      prize: r.prize_name as string,
      rarity: r.rarity as string,
      points: r.points as number,
      delivered_at: (r.delivered_at as string | null | undefined) ?? null,
      trackable: "delivered_at" in r, // false until the database update adds the column
      tx: r.request_tx && vrf.explorer_url ? `${vrf.explorer_url.replace(/\/$/, "")}/tx/${r.request_tx}` : null,
    }));
  });

export const adminMarkDelivered = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ spinId: z.string().uuid(), delivered: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { error } = await db
      .from("spins")
      .update(data.delivered ? { delivered_at: new Date().toISOString(), delivered_by: context.userId } : { delivered_at: null, delivered_by: null })
      .eq("id", data.spinId)
      .eq("status", "fulfilled");
    if (error) throw new Error(error.message);
    await audit(context.userId, data.delivered ? "prize.delivered" : "prize.undelivered", { spin_id: data.spinId });
    return { ok: true };
  });

/** Use granted demo spins on the demo machine (simulated, no prizes). Returns how many were available. */
export const redeemDemoSpins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ count: z.number().int().min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const { useDemoSpins } = await import("./grants.server");
    return { used: await useDemoSpins(await admin(), context.userId, data.count) };
  });

export const adminSetLevel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tokenId: z.string().regex(/^\d+$/), level: z.number().int().min(0).max(100).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: ex } = await db.from("nft_holdings").select("token_id").eq("token_id", data.tokenId).maybeSingle();
    if (!ex) throw new Error("Token not synced yet");
    await db.from("nft_holdings").update({ level_override: data.level }).eq("token_id", data.tokenId);
    await audit(context.userId, "nft.level_override", data);
    return { ok: true };
  });

// ---------- Admin: Chainlink VRF ----------
export const adminVrfStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const vrf = await import("./vrf.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const db = await admin();
    const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
    const { count: pendingDb } = await db.from("spins").select("id", { count: "exact", head: true }).eq("status", "pending");
    const local = vrf.poolArrays(prizes ?? []);
    const unpublished = ((prizes ?? []) as PrizeRow[]).filter((p: PrizeRow) => p.onchain_index == null && p.active).length;
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg?.contract ?? "")) return { configured: false as const, enabled: !!cfg?.enabled, pendingDb: pendingDb ?? 0, unpublished };
    const chain = await vrf.readPool(cfg);
    return {
      configured: true as const,
      enabled: !!cfg.enabled,
      contract: cfg.contract,
      contractUrl: cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/address/${cfg.contract}` : undefined,
      poolVersion: chain.version,
      pendingOnChain: chain.pending,
      pendingDb: pendingDb ?? 0,
      oddsInSync: unpublished === 0 && vrf.weightsMatch(local, chain.pool),
      unpublished,
      chainPool: chain.pool,
    };
  });

export const adminPublishPool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const vrf = await import("./vrf.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg?.contract ?? "")) throw new Error("Set vrf.contract in Configuration first");
    const db = await admin();
    const { data: all } = await db.from("prizes").select("id, weight, inventory, active, onchain_index, created_at").order("created_at").order("id");
    const prizeRows = (all ?? []) as PrizeRow[];
    let next = Math.max(-1, ...prizeRows.map((p: PrizeRow) => p.onchain_index ?? -1)) + 1;
    for (const p of prizeRows) {
      if (p.onchain_index == null && p.active) {
        if (next >= 32) throw new Error("The contract holds at most 32 prizes");
        await db.from("prizes").update({ onchain_index: next }).eq("id", p.id);
        p.onchain_index = next++;
      }
    }
    const { weights, remaining } = vrf.poolArrays(all ?? []);
    if (!weights.length) throw new Error("No active prizes to publish");
    const hash = await vrf.publishPoolOnChain(cfg, weights, remaining);
    await audit(context.userId, "vrf.pool_published", { tx: hash, weights, remaining });
    return { txHash: hash as string, txUrl: vrf.txUrl(cfg, hash) };
  });

export const adminSettleDraws = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const db = await admin();
    const { data: rows } = await db.from("spins").select("id, status, created_at, request_tx").eq("status", "pending").limit(200);
    const before = rows?.length ?? 0;
    for (let i = 0; i < before; i += 10) await settleSpins(cfg, (rows ?? []).slice(i, i + 10));
    const { count } = await db.from("spins").select("id", { count: "exact", head: true }).eq("status", "pending");
    await audit(context.userId, "vrf.settled", { before, after: count });
    return { before, after: count ?? 0 };
  });

/** Whether real (on-chain) spins are open right now. Players can't read the draw settings themselves. */
export const getDrawStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const cfg = (await getConfig("vrf")) as { enabled?: boolean; contract?: string };
    const open = !!cfg?.enabled && /^0x[0-9a-fA-F]{40}$/.test(cfg?.contract ?? "");
    return { open };
  });

// ---------- Admin: one-click on-chain draw setup (Chainlink VRF on Base) ----------
async function mergeConfig(key: string, patch: Record<string, unknown>) {
  const db = await admin();
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  const value = { ...((data?.value as Record<string, unknown> | null) ?? {}), ...patch };
  const { error } = await db.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Couldn't save ${key} settings: ${error.message}`);
  return value;
}

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const adminVrfSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        network: z.enum(["base", "base-sepolia", "custom"]),
        fundEth: z.string().regex(/^\d+(\.\d{1,18})?$/),
        /** Only for "custom" (another chain Chainlink supports, or a local test chain). */
        custom: z
          .object({ chain: z.string().min(1).max(40), chain_id: z.number().int().positive(), rpc_url: z.string().url(), explorer_url: z.string().max(200), coordinator: addr, key_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const s = await import("./vrf-setup.server");
    const net = data.network === "custom" ? data.custom : s.VRF_NETWORKS[data.network];
    if (!net) throw new Error("Enter the custom network details");
    const current = (await getConfig("vrf")) as import("./vrf-setup.server").VrfSetupState;
    if (current.enabled) throw new Error("Switch real spins off before changing the on-chain draw.");
    try {
      const r = await s.setupOnChainDraw({ net, fundEth: data.fundEth, current, save: async (patch) => void (await mergeConfig("vrf", patch)) });
      await audit(context.userId, "vrf.setup", { network: net.chain, steps: r.steps });
      return { steps: r.steps.map((x) => ({ ...x, url: x.tx && net.explorer_url ? `${net.explorer_url.replace(/\/$/, "")}/tx/${x.tx}` : undefined })) };
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      await audit(context.userId, "vrf.setup_failed", { network: net.chain, error: msg });
      throw new Error(`${msg} — fix that and press Set up again; finished steps are kept.`);
    }
  });

export const adminVrfTopUp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ eth: z.string().regex(/^\d+(\.\d{1,18})?$/) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const s = await import("./vrf-setup.server");
    const hash = await s.topUpSubscription((await getConfig("vrf")) as import("./vrf-setup.server").VrfSetupState, data.eth);
    await audit(context.userId, "vrf.topped_up", { eth: data.eth, tx: hash });
    return { txHash: hash as string };
  });

/** Switch real (on-chain) spins on or off. Turning on checks the contract and odds first. */
export const adminVrfSwitch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    if (data.enabled) {
      const vrf = await import("./vrf.server");
      const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
      if (!/^0x[0-9a-fA-F]{40}$/.test(cfg?.contract ?? "")) throw new Error("Set up the on-chain draw first");
      if (!/^0x[0-9a-fA-F]{64}$/.test(process.env["VRF_OPERATOR_PRIVATE_KEY"] ?? "")) throw new Error("The server secret VRF_OPERATOR_PRIVATE_KEY is missing");
      const db = await admin();
      const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
      const chain = await vrf.readPool(cfg);
      if (!chain.pool.length || !vrf.weightsMatch(vrf.poolArrays(prizes ?? []), chain.pool)) throw new Error("Publish the prize pool first, so the odds players see are the odds the contract uses");
    }
    await mergeConfig("vrf", { enabled: data.enabled });
    await audit(context.userId, data.enabled ? "vrf.enabled" : "vrf.disabled", {});
    return { enabled: data.enabled };
  });

export const adminVrfSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const s = await import("./vrf-setup.server");
    const cfg = (await getConfig("vrf")) as import("./vrf-setup.server").VrfSetupState;
    let operator: string | null = null;
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const k = process.env["VRF_OPERATOR_PRIVATE_KEY"];
      if (k && /^0x[0-9a-fA-F]{64}$/.test(k)) operator = privateKeyToAccount(k as `0x${string}`).address;
    } catch {
      /* no key */
    }
    const sub = await s.subscriptionStatus(cfg).catch((e: Error) => ({ error: e.message }));
    return { operator, network: cfg.chain ?? null, sub };
  });

/** Switch $APE spin purchases on or off. Turning on checks the treasury, price and on-chain draw first. */
export const adminPurchaseSwitch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    if (data.enabled) {
      const p = await import("./purchase.server");
      const cfg = (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig;
      if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.treasury ?? "")) throw new Error("Set purchase.treasury (the wallet that receives APE) in Configuration first");
      await p.quoteSpinPrice(cfg); // throws if the price or live APE rate isn't available
      const vrf = await getConfig("vrf");
      if (!vrf.enabled || !/^0x[0-9a-fA-F]{40}$/.test(vrf.contract ?? "")) throw new Error("Switch real spins on first, so every spin sold can be drawn");
    }
    await mergeConfig("purchase", { enabled: data.enabled });
    await audit(context.userId, data.enabled ? "purchase.enabled" : "purchase.disabled", {});
    return { enabled: data.enabled };
  });

/** Recent purchases for the admin console. */
export const adminListPurchases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: rows, error } = await db.from("spin_purchases").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    const cfg = (await getConfig("purchase")) as { explorer_url?: string };
    const emails = new Map<string, string>();
    type P = { id: string; user_id: string; created_at: string; quantity: number; price_wei: string | number; status: string; tx_hash?: string | null };
    for (const id of new Set(((rows ?? []) as P[]).map((r) => r.user_id))) {
      const { data: u } = await db.auth.admin.getUserById(id);
      emails.set(id, u?.user?.email ?? id);
    }
    const { formatEther } = await import("viem");
    return ((rows ?? []) as P[]).map((r) => ({
      id: r.id,
      at: r.created_at,
      player: emails.get(r.user_id) ?? r.user_id,
      quantity: r.quantity,
      ape: formatEther(BigInt(String(r.price_wei))),
      status: r.status,
      tx: r.tx_hash && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${r.tx_hash}` : null,
    }));
  });

// ---------- Spin purchases (APE on ApeChain) ----------
export const getPurchaseSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const cfg = await getConfig("purchase") as import("./purchase.server").PurchaseConfig;
    return { enabled: cfg.enabled, chain_id: cfg.chain_id, rpc_url: cfg.rpc_url, explorer_url: cfg.explorer_url,
      treasury: cfg.treasury, price_ape_per_spin: cfg.price_ape_per_spin ?? "", price_usd_per_spin: cfg.price_usd_per_spin,
      bundles: cfg.bundles, privy_app_id: cfg.privy_app_id };
  });

export const getSpinPriceQuote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const p = await import("./purchase.server");
    return p.quoteSpinPrice(await getConfig("purchase"));
  });

// The player picks a bundle (5, 10, 15 or 20 spins); we lock the price in a purchase row and the
// wallet sends that exact APE amount to the treasury with the purchase id as calldata.
export const createSpinPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ quantity: z.number().int() }).parse(d))
  .handler(async ({ data, context }) => {
    const p = await import("./purchase.server");
    const cfg = p.requirePurchasing((await getConfig("purchase")) as import("./purchase.server").PurchaseConfig);
    const bundles = cfg.bundles?.length ? cfg.bundles : p.DEFAULT_BUNDLES;
    if (!bundles.includes(data.quantity) || data.quantity % 5 !== 0 || data.quantity > 20) throw new Error("Choose 5, 10, 15 or 20 spins.");
    const vrf = await getConfig("vrf");
    if (!vrf.enabled || !/^0x[0-9a-fA-F]{40}$/.test(vrf.contract ?? "")) throw new Error("Purchases will open when the real prize draw is ready.");
    const quote = await p.quoteSpinPrice(cfg);
    const price = BigInt(quote.eachWei) * BigInt(data.quantity);
    const db = await admin();
    const { data: row, error } = await db
      .from("spin_purchases")
      .insert({ user_id: context.userId, quantity: data.quantity, price_wei: price.toString(), chain_id: cfg.chain_id, treasury: cfg.treasury.toLowerCase() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.created", { id: row.id, quantity: data.quantity, price_wei: price.toString() });
    return {
      purchaseId: row.id as string,
      chainId: cfg.chain_id,
      to: cfg.treasury,
      valueWei: price.toString(),
      data: p.purchaseData(row.id),
      explorerUrl: cfg.explorer_url ?? null,
    };
  });

export const confirmSpinPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ purchaseId: z.string().uuid(), txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const p = await import("./purchase.server");
    const cfg = (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig;
    const db = await admin();
    const { data: row } = await db.from("spin_purchases").select("*").eq("id", data.purchaseId).eq("user_id", context.userId).maybeSingle();
    if (!row) throw new Error("Purchase not found");
    if (row.status === "paid") return { status: "paid" as const, quantity: row.quantity as number };
    const check = await p.checkPayment(
      { ...cfg, chain_id: row.chain_id, treasury: row.treasury }, // verify against the terms locked at purchase time
      data.txHash as `0x${string}`,
      row.id,
      BigInt(row.price_wei),
    );
    if (check.state === "pending") return { status: "pending" as const, quantity: row.quantity as number };
    if (check.state === "invalid") throw new Error(check.reason);
    const { error } = await db.rpc("complete_spin_purchase", { _purchase_id: row.id, _tx_hash: data.txHash, _payer: check.payer });
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.paid", { id: row.id, tx: data.txHash, quantity: row.quantity });
    return { status: "paid" as const, quantity: row.quantity as number };
  });

// ---------- Admin: setup checklist ----------
// Reports which settings/keys are in place. Never returns secret values — only whether they're set.
type SetupItem = { group: string; label: string; ok: boolean; optional?: boolean; detail: string; where: string };

export const adminSetupStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const items: SetupItem[] = [];
    const isAddr = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    const cfg = async (key: string) => (await db.from("app_config").select("value").eq("key", key).maybeSingle()).data?.value ?? null;

    // Connections: Supabase (Lovable Cloud) from this server
    const envSet = (k: string) => !!process.env[k];
    const sbEnv = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
    const sbMissing = sbEnv.filter((k) => !envSet(k));
    items.push({ group: "Connections", label: "Supabase (Lovable Cloud) settings on the server", ok: !sbMissing.length, detail: sbMissing.length ? `Missing: ${sbMissing.join(", ")}` : "URL, publishable key and service key are set", where: "Lovable → Cloud is enabled for this project (these are set automatically; reconnect Cloud if any are missing)" });
    const ping = await db.from("app_config").select("key").limit(1);
    items.push({ group: "Connections", label: "Database reachable", ok: !ping.error, detail: ping.error ? ping.error.message || `HTTP ${ping.status}` : "Connected", where: "Lovable → Cloud → Database" });
    const authPing = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
    items.push({ group: "Connections", label: "Player accounts (Supabase Auth) reachable", ok: !authPing.error, detail: authPing.error ? authPing.error.message : "Connected", where: "Lovable → Cloud → Users" });
    items.push({ group: "Connections", label: "Lovable AI key (guide chat)", ok: envSet("LOVABLE_API_KEY"), detail: envSet("LOVABLE_API_KEY") ? "Set" : "Not set — the guide can't answer", where: "Lovable → Cloud → AI (sets LOVABLE_API_KEY automatically)" });

    // Database: each feature's tables (a missing one means its migration hasn't been applied yet)
    const has = async (table: string, cols = "*") => {
      const r = await db.from(table).select(cols).limit(1);
      return r.error ? r.error.message || `HTTP ${r.status}` : null;
    };
    const applyHint = (file: string) => `Lovable applies drizzle/migrations automatically on sync. If this stays red, ask in Lovable chat: “Apply the database migrations in drizzle/migrations” (this one: ${file}).`;
    const dbChecks: { label: string; err: string | null; file: string; optional?: boolean; okDetail: string }[] = [
      { label: "Chainlink draws + spin purchases", err: (await has("spin_purchases", "id")) ?? (await has("spins", "status")), file: "20261006173505_… and 20261006173526_…", okDetail: "Tables are in place" },
      { label: "Privy sign-in", err: await has("privy_accounts", "privy_did"), file: "20261007100000_privy_sign_in_default_wallet.sql", okDetail: "Tables are in place" },
      { label: "Guide chat history", err: await has("guide_messages", "id"), file: "20261006182624_b05bdd69-529e-4952-92bb-d4f7f9811eaa.sql", okDetail: "Tables are in place" },
      { label: "Guide ApeFest info cache", err: await has("event_knowledge", "url"), file: "20261008190000_event_knowledge.sql", optional: true, okDetail: "Tables are in place" },
    ];
    const { grantSchemaReady } = await import("./grants.server");
    const grantsReady = await grantSchemaReady(db).catch(() => false);
    for (const c of dbChecks)
      items.push({ group: "Database", label: c.label, ok: !c.err, ...(c.optional ? { optional: true } : {}), detail: c.err ?? c.okDetail, where: applyHint(c.file) });
    items.push({ group: "Database", label: "Admin spin grants (demo vs paid-equivalent tracking)", ok: grantsReady, optional: true, detail: grantsReady ? "Tables are in place" : "Not applied yet — grants still work (compatibility mode) and move over automatically once it is", where: applyHint("0002_admin_spin_grants.sql") });
    const demoErr = await has("demo_spins", "id");
    items.push({ group: "Database", label: "Demo leaderboard, grant deletion, prize delivery", ok: !demoErr, optional: true, detail: demoErr ?? "Tables are in place", where: applyHint("0003_demo_leaderboard_admin_tools.sql") });

    // Contact form → email
    const { data: lastMail } = await db.from("audit_log").select("action, details, created_at").in("action", ["contact.emailed", "contact.email_failed"]).order("created_at", { ascending: false }).limit(1);
    const lm = (lastMail?.[0] ?? null) as { action: string; details: { recipients?: string[]; failures?: { error: string }[] }; created_at: string } | null;
    items.push({
      group: "Connections",
      label: "Guide contact form emails the team",
      ok: envSet("LOVABLE_API_KEY") && lm?.action !== "contact.email_failed",
      detail: !envSet("LOVABLE_API_KEY") ? "LOVABLE_API_KEY not set" : !lm ? "No message sent yet — send one from the guide's Contact form to test" : lm.action === "contact.emailed" ? `Last message emailed to ${(lm.details.recipients ?? []).join(", ")}` : `Last email failed: ${lm.details.failures?.[0]?.error ?? "unknown error"}`,
      where: "Lovable → Cloud → Emails (sender domain notify.apegamesgotcha.com must be verified). Recipients: every admin's email, or set app_config contact.notify_to",
    });

    // Chainlink VRF draw
    const vrf = (await cfg("vrf")) as { enabled?: boolean; contract?: string; rpc_url?: string; chain_id?: number } | null;
    const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
    const keyOk = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
    items.push({ group: "Chainlink draw (Base)", label: "Draw contract address", ok: isAddr(vrf?.contract), detail: isAddr(vrf?.contract) ? vrf!.contract! : "Not set yet", where: "Admin → Chainlink VRF → Set up the on-chain draw (one button; needs the operator key and a little Base ETH)" });
    items.push({ group: "Chainlink draw (Base)", label: "Operator wallet key (secret)", ok: keyOk, detail: keyOk ? "Set" : key ? "Set, but not a 0x + 64 hex character private key" : "Not set", where: "Lovable → Cloud → Secrets → VRF_OPERATOR_PRIVATE_KEY" });
    if (keyOk && isAddr(vrf?.contract) && vrf?.rpc_url) {
      try {
        const { privateKeyToAccount } = await import("viem/accounts");
        const { createPublicClient, http, parseAbi } = await import("viem");
        const me = privateKeyToAccount(key as `0x${string}`).address;
        const pub = createPublicClient({ transport: http(vrf.rpc_url) });
        const op = await pub.readContract({ address: vrf.contract as `0x${string}`, abi: parseAbi(["function operator() view returns (address)"]), functionName: "operator" });
        const bal = await pub.getBalance({ address: me });
        items.push({ group: "Chainlink draw (Base)", label: "Operator key matches the contract", ok: op.toLowerCase() === me.toLowerCase(), detail: op.toLowerCase() === me.toLowerCase() ? `Operator ${me}` : `Contract operator is ${op}, key is for ${me}`, where: "Use the key for the OPERATOR you deployed with" });
        items.push({ group: "Chainlink draw (Base)", label: "Operator wallet has ETH for gas", ok: bal > 0n, detail: `${Number(bal) / 1e18} ETH`, where: `Send a little ETH (Base) to ${me}` });
      } catch (e) {
        items.push({ group: "Chainlink draw (Base)", label: "Contract reachable", ok: false, detail: (e as Error).message.slice(0, 160), where: "Check vrf.rpc_url and vrf.contract" });
      }
    }
    if (isAddr(vrf?.contract)) {
      try {
        const v = await import("./vrf.server");
        const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
        const chain = await v.readPool(vrf as import("./vrf.server").VrfConfig);
        const ok = v.weightsMatch(v.poolArrays(prizes ?? []), chain.pool) && chain.pool.length > 0;
        items.push({ group: "Chainlink draw (Base)", label: "Prize odds published on-chain", ok, detail: ok ? `Pool v${chain.version}` : "Odds differ from the contract (or never published)", where: "Admin → Chainlink VRF → Publish prize pool" });
      } catch {
        /* covered by "Contract reachable" */
      }
    }
    items.push({ group: "Chainlink draw (Base)", label: "Real spins switched on", ok: !!vrf?.enabled, detail: vrf?.enabled ? "On" : "Off — players see “Spins open soon”", where: "Admin → Chainlink VRF → Set up, Publish prize pool, then Switch real spins on" });

    // Purchases
    const pc = (await cfg("purchase")) as { enabled?: boolean; treasury?: string; price_ape_per_spin?: string; price_usd_per_spin?: string; privy_app_id?: string } | null;
    const price = Number(pc?.price_usd_per_spin ?? pc?.price_ape_per_spin ?? 0);
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Treasury wallet (receives APE)", ok: isAddr(pc?.treasury), detail: pc?.treasury && isAddr(pc.treasury) ? pc.treasury : "Not set — use a regular wallet address, not a Safe/contract", where: "Admin → Configuration → purchase → treasury" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Price per spin", ok: price > 0, detail: price > 0 ? (pc?.price_usd_per_spin ? `$${price} USD in APE per spin` : `${price} APE per spin`) : "Not set", where: "Admin → Configuration → purchase → price_usd_per_spin" });
    items.push({ group: "Sign-in (Login with Glyph)", label: "Privy App ID (Glyph runs through it)", ok: !!pc?.privy_app_id, detail: pc?.privy_app_id ? "Set" : "Not set — nobody can sign in", where: "dashboard.privy.io → App settings → App ID → Admin → Configuration → purchase → privy_app_id. In Privy also: User management → Global wallet → Integrations → turn ON Glyph; turn OFF Email, Google, X, Apple and Web3 wallet login (Glyph offers those); add your published + preview domains under Allowed origins" });
    const privySecret = !!process.env["PRIVY_APP_SECRET"];
    const firecrawl = !!process.env["FIRECRAWL_API_KEY"];
    const { data: ekRows } = await db.from("event_knowledge").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
    const lastFetch = (ekRows?.[0]?.fetched_at as string | undefined) ?? null;
    items.push({ group: "Guide: ApeFest 2026 info", label: "Firecrawl API key (secret)", ok: firecrawl, detail: firecrawl ? `Set${lastFetch ? ` · BAYC pages last fetched ${new Date(lastFetch).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : " · not fetched yet (use “Refresh ApeFest info” below)"}` : "Not set — the guide only knows the basic event facts", where: "Lovable → Connectors → Firecrawl (sets FIRECRAWL_API_KEY), or firecrawl.dev → API keys → Lovable → Cloud → Secrets → FIRECRAWL_API_KEY" });
    items.push({ group: "Sign-in (Login with Glyph)", label: "Privy App Secret (secret)", ok: privySecret, detail: privySecret ? "Set" : "Not set — Glyph sign-in can't finish without it", where: "dashboard.privy.io → App settings → API keys → App secret → Lovable → Cloud → Secrets → PRIVY_APP_SECRET" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Purchases switched on", ok: !!pc?.enabled, detail: pc?.enabled ? "On" : "Off — Refill shows “purchases open soon”", where: "Admin → Chainlink VRF → Spin purchases → Switch purchases on (after real spins are on)" });
    return items;
  });

// ---------- Privy sign-in & default wallet ----------
// Login with Glyph (a Privy cross-app login through the app's Privy app) is the sign-in window; the player's
// Glyph wallet is linked as their default wallet. (Older Privy logins with email or an embedded wallet for players who
// don't have one. The server verifies the Privy session, maps it to a Supabase account (same Privy login,
// same verified email, or same linked wallet) and hands back a one-time token the browser swaps for a
// normal Supabase session. Supabase stays the source of truth for the app; Privy is the front door.

/** Public, non-secret bits the sign-in window needs before anyone is signed in. */
export const getPrivyPublicConfig = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = (await getConfig("purchase").catch(() => null)) as import("./purchase.server").PurchaseConfig | null;
  return {
    privy_app_id: cfg?.privy_app_id?.trim() || null,
    chain_id: cfg?.chain_id ?? 33139,
    rpc_url: cfg?.rpc_url ?? "https://rpc.apechain.com/http",
    explorer_url: cfg?.explorer_url ?? null,
  };
});

async function privyIdentityFromToken(accessToken: string) {
  const cfg = (await getConfig("purchase").catch(() => null)) as import("./purchase.server").PurchaseConfig | null;
  const appId = cfg?.privy_app_id?.trim();
  if (!appId) throw new Error("Privy sign-in isn't set up yet.");
  const privy = await import("./privy.server");
  const did = await privy.verifyPrivyAccessToken(accessToken, appId);
  return privy.fetchPrivyIdentity(did, appId);
}

/** Adds the player's Privy wallets to their account and makes sure they have a default wallet. */
async function syncPrivyWallets(userId: string, identity: import("./privy.server").PrivyIdentity) {
  const db = await admin();
  const skipped: string[] = [];
  for (const w of identity.wallets) {
    const { data: existing } = await db.from("wallets").select("user_id, kind").eq("address", w.address).maybeSingle();
    if (existing && existing.user_id !== userId) {
      skipped.push(w.address);
      continue;
    }
    if (!existing) {
      await db.from("wallets").insert({ user_id: userId, address: w.address, kind: w.kind });
      await audit(userId, "wallet.linked", { address: w.address, via: "privy", kind: w.kind });
    } else if (w.kind === "privy" && existing.kind !== "privy") {
      await db.from("wallets").update({ kind: "privy" }).eq("address", w.address);
    }
  }
  const { data: mine } = await db.from("wallets").select("address, kind, is_default, verified_at").eq("user_id", userId).order("verified_at");
  const rows = (mine ?? []) as { address: string; kind: string; is_default: boolean }[];
  if (rows.length && !rows.some((r) => r.is_default)) {
    // The wallet Privy created is the default; otherwise the wallet they signed in with; otherwise the oldest.
    const pick = rows.find((r) => r.kind === "glyph") ?? rows.find((r) => r.kind === "privy") ?? rows.find((r) => identity.wallets.some((w) => w.address === r.address)) ?? rows[0]!;
    await db.from("wallets").update({ is_default: true }).eq("user_id", userId).eq("address", pick.address);
  }
  return { skipped };
}

export const privySignIn = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const db = await admin();

    // 1) Same Privy login as before  2) same verified email  3) a wallet already linked to an account.
    let userId: string | null = ((await db.from("privy_accounts").select("user_id").eq("privy_did", identity.did).maybeSingle()).data?.user_id as string | undefined) ?? null;
    if (!userId && identity.email) {
      const { data: id } = await db.rpc("user_id_by_email", { _email: identity.email });
      userId = (id as string | null) ?? null;
    }
    if (!userId && identity.wallets.length) {
      const { data: w } = await db.from("wallets").select("user_id").in("address", identity.wallets.map((x) => x.address)).limit(1).maybeSingle();
      userId = (w?.user_id as string | undefined) ?? null;
    }

    let email: string | null = null;
    if (userId) {
      const { data: u } = await db.auth.admin.getUserById(userId);
      email = u?.user?.email ?? null;
      if (!email) {
        email = identity.email ?? `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
        await db.auth.admin.updateUserById(userId, { email, email_confirm: true });
      }
    } else {
      // New player. Wallet-only sign-ins get a placeholder address; no email is ever sent to it.
      email = identity.email ?? `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
      const { data: created, error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { privy_did: identity.did } });
      if (error || !created?.user) throw new Error(error?.message ?? "Couldn't create your account");
      userId = created.user.id as string;
      await audit(userId, "user.created", { via: "privy" });
    }

    await db.from("privy_accounts").upsert({ privy_did: identity.did, user_id: userId }, { onConflict: "privy_did" });
    await syncPrivyWallets(userId!, identity);

    const { data: link, error: linkError } = await db.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link?.properties?.hashed_token as string | undefined;
    if (linkError || !tokenHash) throw new Error(linkError?.message ?? "Couldn't start your session");
    await audit(userId!, "user.signed_in", { via: "privy" });
    return { tokenHash };
  });

/** A signed-in player who also signs in to Privy (e.g. to pay): attach that Privy login and its wallets. */
export const linkPrivyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data, context }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const db = await admin();
    const { data: row } = await db.from("privy_accounts").select("user_id").eq("privy_did", identity.did).maybeSingle();
    if (row && row.user_id !== context.userId) throw new Error("That Privy login belongs to another player. Sign out and sign in with it instead.");
    if (!row) await db.from("privy_accounts").insert({ privy_did: identity.did, user_id: context.userId });
    const { skipped } = await syncPrivyWallets(context.userId, identity);
    return { skipped };
  });

/** Account preferences: choose which linked wallet is the default (used to pay for spins). */
export const setDefaultWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const address = data.address.toLowerCase();
    const { data: w } = await db.from("wallets").select("id").eq("user_id", context.userId).eq("address", address).maybeSingle();
    if (!w) throw new Error("That wallet isn't linked to your account");
    await db.from("wallets").update({ is_default: false }).eq("user_id", context.userId).eq("is_default", true);
    const { error } = await db.from("wallets").update({ is_default: true }).eq("id", w.id);
    if (error) throw new Error(error.message);
    await audit(context.userId, "wallet.default", { address });
    return { address };
  });

// ---------- Guide: ApeFest 2026 info (Firecrawl) ----------
export const adminRefreshEventInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const ek = await import("./event-knowledge.server");
    if (!ek.firecrawlConfigured()) throw new Error("Add the FIRECRAWL_API_KEY secret first.");
    const db = await admin();
    const cfg = ek.eventConfig(await getConfig("event_info").catch(() => null));
    const r = await ek.refreshEventKnowledge(db, cfg);
    await audit(context.userId, "event_info.refreshed", r);
    const { data } = await db.from("event_knowledge").select("url, title, source, fetched_at").order("fetched_at", { ascending: false });
    return { ...r, pages: (data ?? []) as { url: string; title: string | null; source: string; fetched_at: string }[] };
  });

export const adminEventInfoPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data } = await db.from("event_knowledge").select("url, title, source, fetched_at").order("fetched_at", { ascending: false });
    return (data ?? []) as { url: string; title: string | null; source: string; fetched_at: string }[];
  });
