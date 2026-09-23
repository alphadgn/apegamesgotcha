import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
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

// ---------- Spin ----------
export const spin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data, error } = await db.rpc("perform_spin", { _user_id: context.userId });
    if (error) throw new Error(error.message);
    return data as { id: string; prize_name: string; rarity: string; points: number };
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
