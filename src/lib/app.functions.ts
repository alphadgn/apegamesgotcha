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
    if (!existing) await db.from("wallets").insert({ user_id: context.userId, address });
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
  .handler(async ({ data, context }) => {
    const { verifyBurnTx, fetchLevel } = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    if (!wallets?.length) throw new Error("Link a wallet first");
    await verifyBurnTx(cfg, data.txHash as `0x${string}`, BigInt(data.tokenId), wallets.map((w) => w.address));
    const { data: h } = await db.from("nft_holdings").select("level, level_override").eq("token_id", data.tokenId).maybeSingle();
    const level = h?.level_override ?? h?.level ?? (await fetchLevel(cfg, BigInt(data.tokenId)));
    if (level == null) throw new Error("Could not read this NFT's level. Ask an admin to verify it.");
    if (level < Number(cfg.burn_min_level)) throw new Error(`Only Level ${cfg.burn_min_level}+ NFTs are eligible`);
    const { error } = await db.from("burn_claims").insert({ user_id: context.userId, token_id: data.tokenId, tx_hash: data.txHash.toLowerCase(), level });
    if (error) throw new Error("This NFT or transaction was already claimed");
    await db.from("spin_credits").insert({ user_id: context.userId, source: "burn", ref: data.tokenId });
    await db.from("nft_holdings").upsert({ token_id: data.tokenId, owner_address: cfg.burn_address.toLowerCase(), user_id: context.userId, level, burned: true });
    await audit(context.userId, "nft.burned", data);
    return { ok: true };
  });

// ---------- Spins (Chainlink VRF) ----------
// The prize is drawn on-chain by the GotchaVRF contract. The server reserves credits,
// sends the request, and records whatever the contract drew. It never generates randomness.

type SpinRow = { id: string; status: string; created_at: string; request_tx: string | null };

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
      return rows ?? [];
    };
    let rows = await load();
    if (rows.some((r) => r.status === "pending")) {
      await settleSpins(cfg, rows);
      rows = await load();
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
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
    z.object({ email: z.string().email(), spins: z.number().int().min(0).max(100), points: z.number().int(), note: z.string().max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
    const user = list?.users.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
    if (!user) throw new Error("No user with that email");
    if (data.spins > 0) {
      await db.from("spin_credits").insert(Array.from({ length: data.spins }, () => ({ user_id: user.id, source: "grant", created_by: context.userId })));
    }
    if (data.points !== 0) {
      await db.from("points_ledger").insert({ user_id: user.id, amount: data.points, reason: "admin_adjustment", created_by: context.userId });
    }
    await audit(context.userId, "admin.grant", { ...data, user_id: user.id });
    return { ok: true };
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
    const unpublished = (prizes ?? []).filter((p) => p.onchain_index == null && p.active).length;
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
    let next = Math.max(-1, ...(all ?? []).map((p) => p.onchain_index ?? -1)) + 1;
    for (const p of all ?? []) {
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
