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
  .handler(async ({ data, context }) => {
    const { verifyBurnTx, fetchLevel } = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    if (!wallets?.length) throw new Error("Link a wallet first");
    await verifyBurnTx(cfg, data.txHash as `0x${string}`, BigInt(data.tokenId), wallets.map((w: { address: string }) => w.address));
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
    const user = list?.users.find((u: { email?: string; id: string }) => u.email?.toLowerCase() === data.email.toLowerCase());
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

    // Database
    const purchasesTable = await db.from("spin_purchases").select("id", { head: true, count: "exact" });
    const spinsStatus = await db.from("spins").select("status", { head: true, count: "exact" });
    items.push({ group: "Database", label: "Migrations applied (Chainlink draws + purchases)", ok: !purchasesTable.error && !spinsStatus.error, detail: purchasesTable.error?.message ?? spinsStatus.error?.message ?? "Tables are in place", where: "Lovable: apply pending Supabase migrations" });

    // Chainlink VRF draw
    const vrf = (await cfg("vrf")) as { enabled?: boolean; contract?: string; rpc_url?: string; chain_id?: number } | null;
    const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
    const keyOk = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
    items.push({ group: "Chainlink draw (Base)", label: "Draw contract address", ok: isAddr(vrf?.contract), detail: isAddr(vrf?.contract) ? vrf!.contract! : "Not set — deploy contracts/ (see contracts/README.md)", where: "Admin → Configuration → vrf → contract" });
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
    items.push({ group: "Chainlink draw (Base)", label: "Real spins switched on", ok: !!vrf?.enabled, detail: vrf?.enabled ? "On" : "Off — players see “Spins open soon”", where: "Admin → Configuration → vrf → enabled: true (last step)" });

    // Purchases
    const pc = (await cfg("purchase")) as { enabled?: boolean; treasury?: string; price_ape_per_spin?: string; price_usd_per_spin?: string; privy_app_id?: string } | null;
    const price = Number(pc?.price_usd_per_spin ?? pc?.price_ape_per_spin ?? 0);
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Treasury wallet (receives APE)", ok: isAddr(pc?.treasury), detail: pc?.treasury && isAddr(pc.treasury) ? pc.treasury : "Not set — use a regular wallet address, not a Safe/contract", where: "Admin → Configuration → purchase → treasury" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Price per spin", ok: price > 0, detail: price > 0 ? (pc?.price_usd_per_spin ? `$${price} USD in APE per spin` : `${price} APE per spin`) : "Not set", where: "Admin → Configuration → purchase → price_usd_per_spin" });
    items.push({ group: "Sign-in (Privy)", label: "Privy App ID", ok: !!pc?.privy_app_id, detail: pc?.privy_app_id ? "Set" : "Not set — sign-in falls back to email/password and only browser-extension wallets can pay", where: "dashboard.privy.io → App settings → App ID → Admin → Configuration → purchase → privy_app_id. In Privy also: add your published + preview domains under Allowed origins; turn on Email, Google and Wallet login; turn on Ethereum embedded wallets" });
    const privySecret = !!process.env["PRIVY_APP_SECRET"];
    items.push({ group: "Sign-in (Privy)", label: "Privy App Secret (secret)", ok: privySecret, detail: privySecret ? "Set" : "Not set — Privy sign-in can't finish without it", where: "dashboard.privy.io → App settings → API keys → App secret → Lovable → Cloud → Secrets → PRIVY_APP_SECRET" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Purchases switched on", ok: !!pc?.enabled, detail: pc?.enabled ? "On" : "Off — Refill shows “purchases open soon”", where: "Admin → Configuration → purchase → enabled: true (last step)" });
    return items;
  });

// ---------- Privy sign-in & default wallet ----------
// Privy is the sign-in window (email, Google or wallet) and creates an embedded wallet for players who
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
    const pick = rows.find((r) => r.kind === "privy") ?? rows.find((r) => identity.wallets.some((w) => w.address === r.address)) ?? rows[0]!;
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
