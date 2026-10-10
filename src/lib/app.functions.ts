import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Server-only helpers are imported lazily inside handlers so they never reach the browser bundle.
const ctx = () => import("./server-context.server");

async function admin() {
  return (await ctx()).adminClient();
}

async function getConfig(key: string) {
  return (await ctx()).readConfig<any>(key); // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function audit(actor: string | null, action: string, details: unknown) {
  return (await ctx()).audit(actor, action, details);
}

async function assertAdmin(context: { userId: string }) {
  return (await ctx()).assertAdmin(context.userId);
}

const ADDRESS = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const TX = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

// ---------- Wallet linking (SIWE: domain/URI/chain-bound, expiring, single-use) ----------
export const getWalletNonce = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: ADDRESS }).parse(d))
  .handler(async ({ data, context }) => {
    const siwe = await import("./siwe.server");
    const nft = await getConfig("nft");
    const auth = await getConfig("auth").catch(() => ({ allowed_origins: [] }));
    const site = siwe.siteFromRequest(
      getRequest(),
      (auth as { allowed_origins?: string[] }).allowed_origins ?? [],
    );
    const c = siwe.buildChallenge({
      address: data.address,
      chainId: Number(nft.chain_id),
      domain: site.domain,
      uri: site.uri,
    });
    const db = await (await ctx()).serviceDb();
    await db.rpc("issue_wallet_challenge", {
      _user_id: context.userId,
      _address: data.address.toLowerCase(),
      _chain_id: Number(nft.chain_id),
      _domain: site.domain,
      _uri: site.uri,
      _nonce: c.nonce,
      _message: c.message,
      _ttl_seconds: siwe.CHALLENGE_TTL_SECONDS,
    });
    return { message: c.message, nonce: c.nonce };
  });

export const linkWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        nonce: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
        signature: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .max(20_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const siwe = await import("./siwe.server");
    const { nftClient } = await import("./nft.server");
    const c = await ctx();
    const db = await c.serviceDb();
    const [challenge] = await db.select<{
      message: string;
      address: string;
      chain_id: number;
      domain: string;
      nonce: string;
      user_id: string;
    }>("wallet_challenges", { nonce: data.nonce, user_id: context.userId });
    if (!challenge) throw new Error("Request a new signature first");
    const nft = await getConfig("nft");
    await siwe.verifyChallengeSignature(nftClient(nft), challenge, data.signature as `0x${string}`);
    const [w] = await db.rpc<{ address: string }>("link_wallet_with_challenge", {
      _user_id: context.userId,
      _nonce: data.nonce,
      _address: challenge.address,
      _domain: challenge.domain,
      _chain_id: challenge.chain_id,
    });
    return { address: w!.address };
  });

// ---------- Live NFT holdings (display and burn eligibility only — never points) ----------
export const syncNfts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listOwnedTokens, fetchLevel } = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const { data: wallets } = await db
      .from("wallets")
      .select("address")
      .eq("user_id", context.userId);
    const { data: known } = await db
      .from("nft_holdings")
      .select("token_id, level")
      .eq("user_id", context.userId);
    const levels = new Map<string, number | null>(
      ((known ?? []) as { token_id: string; level: number | null }[]).map((h) => [
        h.token_id,
        h.level,
      ]),
    );
    const rows: { token_id: string; owner: string; level: number | null }[] = [];
    let notEnumerable = false;
    for (const w of (wallets ?? []) as { address: string }[]) {
      const r = await listOwnedTokens(cfg, w.address);
      if (!r.enumerable) notEnumerable = true;
      for (const id of r.ids) {
        const tokenId = id.toString();
        const level = levels.has(tokenId) ? levels.get(tokenId)! : await fetchLevel(cfg, id);
        rows.push({ token_id: tokenId, owner: w.address, level });
      }
    }
    const sdb = await (await ctx()).serviceDb();
    await sdb.rpc("sync_live_holdings", { _user_id: context.userId, _rows: rows });
    return { found: rows.length, notEnumerable };
  });

// ---------- Burn for a spin (finalized, canonical, linked wallet, trusted pre-burn level) ----------
export const claimBurn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ txHash: TX, tokenId: z.string().regex(/^\d{1,78}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const nftLib = await import("./nft.server");
    const db = await admin();
    const cfg = await getConfig("nft");
    const { data: wallets } = await db
      .from("wallets")
      .select("address")
      .eq("user_id", context.userId);
    if (!wallets?.length) throw new Error("Link a wallet first");
    const ev = await nftLib.verifyBurn(
      cfg,
      data.txHash as `0x${string}`,
      BigInt(data.tokenId),
      (wallets as { address: string }[]).map((w) => w.address),
    );
    // Level from trusted pre-burn state: admin override, else metadata as of the block before the burn, else the last sync.
    const { data: h } = await db
      .from("nft_holdings")
      .select("level, level_override")
      .eq("token_id", data.tokenId)
      .maybeSingle();
    let level: number | null = h?.level_override ?? null;
    let source = "admin_override";
    if (level == null) {
      level = await nftLib.fetchLevel(cfg, BigInt(data.tokenId), {
        blockNumber: ev.blockNumber - 1n,
      });
      source = "pre_burn_metadata";
    }
    if (level == null && h?.level != null) {
      level = h.level as number;
      source = "synced_holding";
    }
    if (level == null)
      throw new Error(
        "Could not read this NFT's level before the burn. Ask an admin to verify it.",
      );
    const sdb = await (await ctx()).serviceDb();
    await sdb.rpc("record_burn_claim", {
      _user_id: context.userId,
      _chain_id: ev.chainId,
      _contract: ev.contract,
      _token_id: ev.tokenId,
      _tx_hash: ev.txHash,
      _log_index: ev.logIndex,
      _from: ev.from,
      _to: ev.to,
      _level: level,
      _level_source: source,
      _block_number: Number(ev.blockNumber),
      _block_hash: ev.blockHash,
      _confirmations: ev.confirmations,
      _evidence: { verified_at: new Date().toISOString() },
    });
    return { ok: true };
  });

// ---------- Spins (Chainlink VRF) ----------
// The prize is drawn on-chain by the GotchaVRF contract. The server reserves credits, sends the request and
// records whatever the contract drew. It never generates randomness and never refunds on a timeout.

type SpinOutRow = {
  id: string;
  status: string;
  created_at: string;
  batch_id: string | null;
  prize_id: string | null;
  prize_name: string | null;
  rarity: string | null;
  points: number | null;
  participation_points: number | null;
  bonus_points: number | null;
  scored: boolean | null;
  random_word: string | null;
  request_tx: string | null;
};

function publicSpin(r: SpinOutRow, verifyUrl: string | undefined) {
  return {
    id: r.id,
    // A NO_PRIZE result returned the credit, which the machine treats like a refund.
    status: (r.status === "no_prize" ? "refunded" : r.status) as
      "pending" | "fulfilled" | "refunded",
    prize_id: r.prize_id,
    prize_name: r.prize_name,
    rarity: r.rarity,
    points: r.points,
    participation_points: r.participation_points,
    bonus_points: r.bonus_points,
    scored: r.scored,
    random_word: r.random_word,
    request_tx: r.request_tx,
    verify_url: verifyUrl,
  };
}

export const startDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        count: z.number().int().min(1).max(10),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const vrf = await import("./vrf.server");
    const draws = await import("./draws.server");
    const cfg = vrf.requireVrf((await getConfig("vrf")) as import("./vrf.server").VrfConfig);
    if (data.count > (cfg.max_batch ?? 5))
      throw new Error(`Up to ${cfg.max_batch ?? 5} capsules per pull`);
    const deps = await (await ctx()).drawDeps(cfg);
    const r = await draws.reserveAndSubmit(deps, {
      userId: context.userId,
      idempotencyKey: data.idempotencyKey,
      count: data.count,
      chainId: cfg.chain_id,
      contract: cfg.contract,
    });
    await audit(context.userId, "spin.requested", {
      batchId: r.batch.id,
      spins: r.batch.spin_ids.length,
      tx: r.txHash,
    });
    return { spinIds: r.batch.spin_ids, txHash: r.txHash ?? null, txUrl: vrf.txUrl(cfg, r.txHash) };
  });

export const checkDraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const vrf = await import("./vrf.server");
    const draws = await import("./draws.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const db = await admin();
    const cols =
      "id, status, created_at, batch_id, request_tx, prize_id, prize_name, rarity, points, participation_points, bonus_points, scored, random_word";
    const load = async () => {
      const { data: rows, error } = await db
        .from("spins")
        .select(cols)
        .eq("user_id", context.userId)
        .in("id", data.ids);
      if (error) throw new Error(error.message);
      return (rows ?? []) as SpinOutRow[];
    };
    let rows = await load();
    const batchIds = [
      ...new Set(rows.filter((r) => r.status === "pending" && r.batch_id).map((r) => r.batch_id!)),
    ];
    if (batchIds.length) {
      // Nudge this player's batches forward right away; the scheduled worker does the same for everyone.
      const deps = await (await ctx()).drawDeps(cfg);
      for (const id of batchIds) {
        const [b] = await deps.db.select<import("./draws.server").DrawBatch>("draw_batches", {
          id,
        });
        if (b) await draws.reconcileBatch(deps, b).catch(() => {});
      }
      rows = await load();
    }
    const byId = new Map<string, SpinOutRow>(rows.map((r) => [r.id, r]));
    return data.ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [publicSpin(r, vrf.txUrl(cfg, r.request_tx))] : [];
    });
  });

/** Narrow readiness + published odds for an ordinary signed-in player (no config-table access needed). */
export const getMachineReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await (await ctx()).serviceDb();
    const [r] = await db.rpc<
      Record<string, unknown> | { machine_readiness: Record<string, unknown> }
    >("machine_readiness", { _user_id: context.userId });
    const v = (r && "machine_readiness" in r ? r.machine_readiness : r) as {
      open: boolean;
      reason: string | null;
      odds: {
        prize_id: string;
        name: string;
        rarity: string;
        probability: number;
        remaining: number | null;
        bonus: number | null;
      }[];
      season: {
        id: string;
        slug: string;
        name: string;
        ends_at: string;
        participation_points: number;
      } | null;
      expected_bonus_per_spin: number | null;
      expected_points_per_spin: number | null;
      daily_limit: number;
      daily_used: number;
      season_limit: number;
      season_used: number;
    };
    return v;
  });

// ---------- Admin ----------
export const adminUpdateConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ key: z.string().regex(/^[a-z_]{2,40}$/), value: z.record(z.any()) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { error } = await db
      .from("app_config")
      .upsert({ key: data.key, value: data.value, updated_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context.userId, "config.updated", data);
    return { ok: true };
  });

export const adminUpsertPrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(100),
        rarity: z.enum(["common", "rare", "epic", "legendary"]),
        weight: z.number().int().min(0).max(1_000_000),
        inventory: z.number().int().min(0).nullable(),
        active: z.boolean(),
        fulfillment_type: z.enum([
          "unclassified",
          "points_only",
          "digital_free",
          "fulfillment_required",
        ]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await (await ctx()).serviceDb();
    await db.rpc("admin_upsert_prize", {
      _id: data.id ?? null,
      _name: data.name,
      _rarity: data.rarity,
      _weight: data.weight,
      _inventory: data.inventory,
      _active: data.active,
      _fulfillment_type: data.fulfillment_type,
      _actor: context.userId,
    });
    return { ok: true };
  });

export const adminRestockPrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        prizeId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100_000),
        evidence: z.string().min(5).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await (await ctx()).serviceDb();
    await db.rpc("restock_prize", {
      _prize_id: data.prizeId,
      _quantity: data.quantity,
      _evidence: data.evidence,
      _actor: context.userId,
    });
    return { ok: true };
  });

async function userIdByEmail(email: string) {
  const db = await admin();
  const { data, error } = await db.rpc("user_id_by_email", { _email: email });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No player with that email");
  return data as string;
}

/** Sponsored spins (funded from a grant budget) and/or an audited point adjustment in the active season. */
export const adminGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email(),
        spins: z.number().int().min(0).max(100),
        /** real = paid-equivalent on-chain spin (funded from the grant budget); demo = practice spin, no prizes or points. */
        kind: z.enum(["real", "demo"]).default("real"),
        points: z.number().int().min(-1_000_000).max(1_000_000),
        note: z.string().min(5).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const userId = await userIdByEmail(data.email);
    const db = await (await ctx()).serviceDb();
    if (data.spins > 0)
      await db.rpc("grant_spins", {
        _user_id: userId,
        _count: data.spins,
        _reason: data.note,
        _actor: context.userId,
        _source: "grant",
        _kind: data.kind,
      });
    if (data.points !== 0) {
      const raw = await admin();
      const { data: season } = await raw
        .from("seasons")
        .select("id")
        .eq("status", "active")
        .maybeSingle();
      if (!season) throw new Error("Point adjustments need an active season");
      await db.rpc("adjust_points", {
        _season_id: season.id,
        _user_id: userId,
        _amount: data.points,
        _reason: data.note,
        _actor: context.userId,
      });
    }
    return { ok: true };
  });

export type SpinGrantRow = {
  id: string;
  created_at: string;
  kind: "real" | "demo";
  count: number;
  used: number;
  note: string;
  player: string;
  granted_by: string;
};

/** Every admin spin grant with how many of its spins have been used, newest first (admins only). */
export const adminListGrants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SpinGrantRow[]> => {
    await assertAdmin(context);
    const db = await admin();
    const { data: grants, error } = await db
      .from("spin_grants")
      .select("id, created_at, kind, count, note, user_id, created_by")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = (grants ?? []) as {
      id: string;
      created_at: string;
      kind: "real" | "demo";
      count: number;
      note: string;
      user_id: string;
      created_by: string | null;
    }[];
    const ids = rows.map((g) => g.id);
    const used = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: credits, error: e2 } = await db
        .from("spin_credits")
        .select("grant_id, used_spin_id, used_at")
        .in("grant_id", ids.slice(i, i + 100));
      if (e2) throw new Error(e2.message);
      for (const c of (credits ?? []) as { grant_id: string; used_spin_id: string | null; used_at: string | null }[])
        if (c.used_spin_id || c.used_at) used.set(c.grant_id, (used.get(c.grant_id) ?? 0) + 1);
    }
    // Emails stay inside the admin console (never on public surfaces).
    const emails = new Map<string, string>();
    for (let page = 1; page <= 50; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      const users = (data?.users ?? []) as { id: string; email?: string }[];
      for (const u of users) emails.set(u.id, u.email ?? u.id);
      if (users.length < 1000) break;
    }
    return rows.map((g) => ({
      id: g.id,
      created_at: g.created_at,
      kind: g.kind,
      count: g.count,
      used: used.get(g.id) ?? 0,
      note: g.note,
      player: emails.get(g.user_id) ?? g.user_id,
      granted_by: g.created_by ? (emails.get(g.created_by) ?? g.created_by) : "—",
    }));
  });

/** Use granted demo spins on the demo machine (simulated, no prizes). Returns how many were available. */
export const redeemDemoSpins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ count: z.number().int().min(1).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await (await ctx()).serviceDb();
    const [used] = await db.rpc<number>("use_demo_spins", { _user_id: context.userId, _count: data.count });
    return { used: Number(used ?? 0) };
  });

export const adminSetLevel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tokenId: z.string().regex(/^\d+$/),
        level: z.number().int().min(0).max(100).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await (await ctx()).serviceDb();
    await db.rpc("set_holding_level_override", {
      _token_id: data.tokenId,
      _level: data.level,
      _actor: context.userId,
    });
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
    const { count: pendingDb } = await db
      .from("spins")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const { data: pubs } = await db
      .from("pool_publications")
      .select("status, pool_version, confirmed_at, tx_hash")
      .order("prepared_at", { ascending: false })
      .limit(1);
    const lastPublication = (pubs?.[0] ?? null) as {
      status: string;
      pool_version: number | null;
      confirmed_at: string | null;
      tx_hash: string | null;
    } | null;
    const { count: unpublished } = await db
      .from("prizes")
      .select("id", { count: "exact", head: true })
      .is("onchain_index", null)
      .eq("active", true)
      .gt("weight", 0);
    if (!vrf.isAddress(cfg?.contract))
      return {
        configured: false as const,
        enabled: !!cfg?.enabled,
        pendingDb: pendingDb ?? 0,
        unpublished: unpublished ?? 0,
        lastPublication,
      };
    const pub = vrf.vrfPublic(cfg);
    const chain = await vrf.readPool(pub, cfg.contract);
    const sub = await vrf
      .readSubscription(pub, cfg.contract)
      .catch((e: Error) => ({ error: e.message.slice(0, 160) }));
    return {
      configured: true as const,
      enabled: !!cfg.enabled,
      contract: cfg.contract,
      contractUrl: cfg.explorer_url
        ? `${cfg.explorer_url.replace(/\/$/, "")}/address/${cfg.contract}`
        : undefined,
      poolVersion: chain.version,
      pendingOnChain: chain.pending,
      requestsPaused: chain.paused,
      pendingDb: pendingDb ?? 0,
      oddsInSync:
        (unpublished ?? 0) === 0 &&
        lastPublication?.status === "confirmed" &&
        lastPublication.pool_version === chain.version,
      unpublished: unpublished ?? 0,
      lastPublication,
      subscription: sub,
      chainPool: chain.weights.map((w, i) => ({
        weight: w.toString(),
        remaining: chain.remaining[i]!.toString(),
      })),
    };
  });

/** Publish odds + stock: reconcile with the contract first, send setPool, confirm by reading the contract back. */
export const adminPublishPool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const vrf = await import("./vrf.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    if (!vrf.isAddress(cfg?.contract)) throw new Error("Set vrf.contract in Configuration first");
    const db = await (await ctx()).serviceDb();
    const pub = vrf.vrfPublic(cfg);
    const before = await vrf.readPool(pub, cfg.contract);
    const confirmedBefore =
      (
        await (
          await admin()
        )
          .from("pool_publications")
          .select("id")
          .eq("status", "confirmed")
          .eq("contract_address", cfg.contract.toLowerCase())
          .limit(1)
      ).data?.length ?? 0;
    const [prep] = await db.rpc<{ id: string; weights: string[]; remaining: string[] }>(
      "prepare_pool_publication",
      {
        _chain_id: cfg.chain_id,
        _contract: cfg.contract.toLowerCase(),
        _chain_pool_version: confirmedBefore ? before.version : null,
        _chain_remaining: before.remaining.map(String),
        _chain_pending: before.pending,
        _actor: context.userId,
      },
    );
    let hash: `0x${string}`;
    try {
      hash = await vrf.sendSetPool(cfg, prep!.weights.map(BigInt), prep!.remaining.map(BigInt));
    } catch (e) {
      await db.rpc("fail_pool_publication", {
        _publication_id: prep!.id,
        _error: (e as Error).message,
        _actor: context.userId,
      });
      throw new Error(`Couldn't publish: ${(e as Error).message.slice(0, 200)}`);
    }
    await db.rpc("mark_pool_publication_sent", { _publication_id: prep!.id, _tx_hash: hash });
    const receipt = await pub
      .waitForTransactionReceipt({ hash, timeout: 90_000 })
      .catch(() => null);
    if (!receipt)
      return { txHash: hash as string, txUrl: vrf.txUrl(cfg, hash), status: "sent" as const };
    if (receipt.status !== "success") {
      await db.rpc("fail_pool_publication", {
        _publication_id: prep!.id,
        _error: "setPool reverted",
        _actor: context.userId,
      });
      throw new Error("setPool transaction reverted");
    }
    const after = await vrf.readPool(pub, cfg.contract);
    await db.rpc("confirm_pool_publication", {
      _publication_id: prep!.id,
      _pool_version: after.version,
      _chain_weights: after.weights.map(String),
      _chain_remaining: after.remaining.map(String),
      _actor: context.userId,
    });
    return { txHash: hash as string, txUrl: vrf.txUrl(cfg, hash), status: "confirmed" as const };
  });

/** A publication whose transaction outcome wasn't seen: confirm it from what the contract reports now. */
export const adminReconcilePublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const vrf = await import("./vrf.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const raw = await admin();
    const { data: open } = await raw
      .from("pool_publications")
      .select("id, tx_hash, status")
      .in("status", ["prepared", "sent"])
      .limit(1);
    const p = open?.[0] as { id: string; tx_hash: string | null; status: string } | undefined;
    if (!p) return { status: "nothing-open" as const };
    const db = await (await ctx()).serviceDb();
    const pub = vrf.vrfPublic(cfg);
    const receipt = p.tx_hash
      ? await pub.getTransactionReceipt({ hash: p.tx_hash as `0x${string}` }).catch(() => null)
      : null;
    if (receipt?.status === "success") {
      const after = await vrf.readPool(pub, cfg.contract);
      await db.rpc("confirm_pool_publication", {
        _publication_id: p.id,
        _pool_version: after.version,
        _chain_weights: after.weights.map(String),
        _chain_remaining: after.remaining.map(String),
        _actor: context.userId,
      });
      return { status: "confirmed" as const };
    }
    if (receipt?.status === "reverted" || (!p.tx_hash && p.status === "prepared")) {
      await db.rpc("fail_pool_publication", {
        _publication_id: p.id,
        _error: receipt ? "reverted" : "never sent",
        _actor: context.userId,
      });
      return { status: "failed" as const };
    }
    return { status: "still-pending" as const };
  });

export const adminSettleDraws = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const draws = await import("./draws.server");
    const cfg = (await getConfig("vrf")) as import("./vrf.server").VrfConfig;
    const report = await draws.runSettlementPass(await (await ctx()).drawDeps(cfg));
    await audit(context.userId, "vrf.settled", report);
    return report;
  });

// ---------- Spin purchases (APE on ApeChain) ----------
export const getPurchaseSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const cfg = (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig;
    return {
      enabled: cfg.enabled,
      chain_id: cfg.chain_id,
      rpc_url: cfg.rpc_url,
      explorer_url: cfg.explorer_url,
      treasury: cfg.treasury,
      price_ape_per_spin: cfg.price_ape_per_spin ?? "",
      price_usd_per_spin: cfg.price_usd_per_spin,
      bundles: cfg.bundles,
      privy_app_id: cfg.privy_app_id,
    };
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
    const cfg = p.requirePurchasing(
      (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig,
    );
    const bundles = cfg.bundles?.length ? cfg.bundles : p.DEFAULT_BUNDLES;
    if (!bundles.includes(data.quantity) || data.quantity % 5 !== 0 || data.quantity > 20)
      throw new Error("Choose 5, 10, 15 or 20 spins.");
    const vrf = await getConfig("vrf");
    if (!vrf.enabled || !/^0x[0-9a-fA-F]{40}$/.test(vrf.contract ?? ""))
      throw new Error("Purchases will open when the real prize draw is ready.");
    const sdb = await (await ctx()).serviceDb();
    const [gate] = await sdb.rpc<{ ok: boolean; reason: string | null }>("purchase_gate", {
      _quantity: data.quantity,
    });
    if (!gate?.ok)
      throw new Error(`Purchases are paused: ${gate?.reason ?? "economic checks unavailable"}.`);
    const quote = await p.quoteSpinPrice(cfg);
    const price = BigInt(quote.eachWei) * BigInt(data.quantity);
    const usd = cfg.price_usd_per_spin ? Number(cfg.price_usd_per_spin) * data.quantity : null;
    const db = await admin();
    const { data: row, error } = await db
      .from("spin_purchases")
      .insert({
        user_id: context.userId,
        quantity: data.quantity,
        price_wei: price.toString(),
        chain_id: cfg.chain_id,
        treasury: cfg.treasury.toLowerCase(),
        price_usd: usd,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.created", {
      id: row.id,
      quantity: data.quantity,
      price_wei: price.toString(),
    });
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
  .inputValidator((d) => z.object({ purchaseId: z.string().uuid(), txHash: TX }).parse(d))
  .handler(async ({ data, context }) => {
    const p = await import("./purchase.server");
    const cfg = (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig;
    const db = await admin();
    const { data: row } = await db
      .from("spin_purchases")
      .select("*")
      .eq("id", data.purchaseId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!row) throw new Error("Purchase not found");
    if (row.status === "paid") return { status: "paid" as const, quantity: row.quantity as number };
    const check = await p.checkPayment(
      { ...cfg, chain_id: row.chain_id, treasury: row.treasury }, // verify against the terms locked at purchase time
      data.txHash as `0x${string}`,
      row.id,
      BigInt(row.price_wei),
    );
    if (check.state === "pending")
      return { status: "pending" as const, quantity: row.quantity as number };
    if (check.state === "invalid") throw new Error(check.reason);
    const { error } = await db.rpc("complete_spin_purchase", {
      _purchase_id: row.id,
      _tx_hash: data.txHash,
      _payer: check.payer,
    });
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.paid", {
      id: row.id,
      tx: data.txHash,
      quantity: row.quantity,
    });
    return { status: "paid" as const, quantity: row.quantity as number };
  });

// ---------- Admin: setup checklist ----------
// Reports which settings/keys are in place. Never returns secret values — only whether they're set.
type SetupItem = {
  group: string;
  label: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
  where: string;
};

export const adminSetupStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const items: SetupItem[] = [];
    const isAddr = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    const cfg = async (key: string) =>
      (await db.from("app_config").select("value").eq("key", key).maybeSingle()).data?.value ??
      null;

    // Database
    const seasonsTable = await db.from("seasons").select("id", { head: true, count: "exact" });
    const batches = await db.from("draw_batches").select("id", { head: true, count: "exact" });
    items.push({
      group: "Database",
      label: "Migrations applied (seasons, ledger, draw batches)",
      ok: !seasonsTable.error && !batches.error,
      detail: seasonsTable.error?.message ?? batches.error?.message ?? "Tables are in place",
      where: "Lovable: apply pending Supabase migrations",
    });

    // Seasons
    const { data: seasons } = await db
      .from("seasons")
      .select("slug, status, starts_at, ends_at, is_legacy");
    const live = (
      (seasons ?? []) as {
        slug: string;
        status: string;
        is_legacy: boolean;
        ends_at: string | null;
      }[]
    ).filter((s) => !s.is_legacy);
    const active = live.find((s) => s.status === "active");
    items.push({
      group: "Season leaderboard",
      label: "Active season",
      ok: !!active,
      detail: active
        ? `${active.slug} (ends ${active.ends_at})`
        : `None — ${live.filter((s) => s.status === "draft").length} draft(s). Spins award prizes but no seasonal points until a season is activated.`,
      where:
        "Admin → Seasons: create a draft with real UTC dates, link verified snapshot collections, then Activate (deliberate step)",
    });
    const { data: cols } = await db
      .from("nft_collections")
      .select("status, contract, edition, snapshot_block");
    const verified = ((cols ?? []) as { status: string }[]).filter(
      (c) => c.status === "verified" || c.status === "frozen",
    ).length;
    items.push({
      group: "Season leaderboard",
      label: "Verified 2025 snapshot collection",
      ok: verified > 0,
      detail: verified
        ? `${verified} verified`
        : "Only a CANDIDATE contract (ApeChain 0x8Bb7…c28b) — confirm it, set the snapshot block + hash, index, then verify",
      where: "Admin → Snapshots",
    });
    items.push({
      group: "Season leaderboard",
      label: "Archive RPC for snapshot verification (secret)",
      ok: !!process.env["ARCHIVE_RPC_URL_33139"],
      optional: !verified,
      detail: process.env["ARCHIVE_RPC_URL_33139"]
        ? "Set"
        : "Not set — snapshot claims stay pending (never fall back to current ownership)",
      where: "Lovable → Cloud → Secrets → ARCHIVE_RPC_URL_33139 (an archive-capable ApeChain RPC)",
    });
    const social = (await cfg("social")) as { verifier?: string } | null;
    items.push({
      group: "Season leaderboard",
      label: "X share verification",
      ok: !!process.env["X_API_BEARER_TOKEN"] || social?.verifier === "manual_review",
      optional: true,
      detail: process.env["X_API_BEARER_TOKEN"]
        ? "X API (with manual review fallback)"
        : "Manual review only (audited). Share rewards stay off unless the season enables them.",
      where: "Optional secret X_API_BEARER_TOKEN; Admin → Shares for the review queue",
    });
    items.push({
      group: "Season leaderboard",
      label: "Settlement worker secret",
      ok: !!process.env["LOVABLE_CRON_SECRET"],
      detail: process.env["LOVABLE_CRON_SECRET"]
        ? "Set"
        : "Not set — schedule POST /api/cron/settle with Authorization: Bearer <secret>",
      where: "Lovable → Cloud → Secrets → LOVABLE_CRON_SECRET, then a scheduled job every minute",
    });

    // Economics
    const sdb = await (await ctx()).serviceDb();
    const [econRow] = await sdb.rpc<
      { economic_status: Record<string, unknown> } | Record<string, unknown>
    >("economic_status", {});
    const econ = (
      econRow && "economic_status" in econRow ? econRow.economic_status : econRow
    ) as Record<string, unknown>;
    const problems = (econ?.["catalog_problems"] as unknown[] | undefined)?.length ?? 0;
    items.push({
      group: "Prize economics",
      label: "Every prize classified and verified",
      ok: problems === 0,
      detail: problems ? `${problems} problem(s) — draws stay paused` : "OK",
      where: "Admin → Economics / Prizes & odds",
    });
    items.push({
      group: "Prize economics",
      label: "Draw costs measured (gas, VRF, provider)",
      ok: econ?.["expected_spin_cost_usd"] != null,
      detail:
        econ?.["expected_spin_cost_usd"] != null
          ? `Expected ≈ $${econ["expected_spin_cost_usd"]} per spin`
          : "Unverified (unknown costs are never treated as zero)",
      where: "Admin → Economics → Operating costs",
    });

    // Chainlink VRF draw
    const vrf = (await cfg("vrf")) as {
      enabled?: boolean;
      contract?: string;
      rpc_url?: string;
      chain_id?: number;
    } | null;
    const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
    const keyOk = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
    items.push({
      group: "Chainlink draw (Base)",
      label: "Draw contract address",
      ok: isAddr(vrf?.contract),
      detail: isAddr(vrf?.contract)
        ? vrf!.contract!
        : "Not set — deploy contracts/ (see contracts/README.md). Older deployments with cancelRequest must be replaced.",
      where: "Admin → Configuration → vrf → contract",
    });
    items.push({
      group: "Chainlink draw (Base)",
      label: "Operator wallet key (secret)",
      ok: keyOk,
      detail: keyOk ? "Set" : key ? "Set, but not a 0x + 64 hex character private key" : "Not set",
      where: "Lovable → Cloud → Secrets → VRF_OPERATOR_PRIVATE_KEY",
    });
    if (keyOk && isAddr(vrf?.contract) && vrf?.rpc_url) {
      try {
        const v = await import("./vrf.server");
        const { privateKeyToAccount } = await import("viem/accounts");
        const me = privateKeyToAccount(key as `0x${string}`).address;
        const pub = v.vrfPublic(vrf as import("./vrf.server").VrfConfig);
        const { gotchaVrfAbi } = await import("./gotchaVrfAbi");
        const op = await pub.readContract({
          address: vrf.contract as `0x${string}`,
          abi: gotchaVrfAbi,
          functionName: "operator",
        });
        const bal = await pub.getBalance({ address: me });
        items.push({
          group: "Chainlink draw (Base)",
          label: "Operator key matches the contract",
          ok: op.toLowerCase() === me.toLowerCase(),
          detail:
            op.toLowerCase() === me.toLowerCase()
              ? `Operator ${me}`
              : `Contract operator is ${op}, key is for ${me}`,
          where: "Use the key for the OPERATOR you deployed with",
        });
        items.push({
          group: "Chainlink draw (Base)",
          label: "Operator wallet has ETH for gas",
          ok: bal > 0n,
          detail: `${Number(bal) / 1e18} ETH`,
          where: `Send a little ETH (Base) to ${me}`,
        });
        const sub = await v.readSubscription(pub, vrf.contract!);
        items.push({
          group: "Chainlink draw (Base)",
          label: "VRF subscription funded and consumer added",
          ok: BigInt(sub.balance) > 0n && sub.isConsumer,
          detail: `Subscription ${sub.subId}: balance ${sub.balance} (${sub.nativePayment ? "native" : "LINK"} wei)${sub.isConsumer ? "" : " · contract is NOT a consumer"}`,
          where: "vrf.chain.link → your subscription",
        });
      } catch (e) {
        items.push({
          group: "Chainlink draw (Base)",
          label: "Contract reachable",
          ok: false,
          detail: (e as Error).message.slice(0, 160),
          where: "Check vrf.rpc_url and vrf.contract",
        });
      }
    }
    const { data: lastPub } = await db
      .from("pool_publications")
      .select("status, pool_version")
      .order("prepared_at", { ascending: false })
      .limit(1);
    const lp = lastPub?.[0] as { status: string; pool_version: number | null } | undefined;
    items.push({
      group: "Chainlink draw (Base)",
      label: "Prize odds published on-chain",
      ok: lp?.status === "confirmed",
      detail: lp
        ? `Last publication ${lp.status}${lp.pool_version ? ` (v${lp.pool_version})` : ""}`
        : "Never published",
      where: "Admin → Chainlink VRF → Publish prize pool",
    });
    items.push({
      group: "Chainlink draw (Base)",
      label: "Real spins switched on",
      ok: !!vrf?.enabled,
      detail: vrf?.enabled ? "On" : "Off — players see “Spins open soon”",
      where: "Admin → Configuration → vrf → enabled: true (last step; not done automatically)",
    });

    // Purchases
    const pc = (await cfg("purchase")) as {
      enabled?: boolean;
      treasury?: string;
      price_ape_per_spin?: string;
      price_usd_per_spin?: string;
      privy_app_id?: string;
    } | null;
    const price = Number(pc?.price_usd_per_spin ?? pc?.price_ape_per_spin ?? 0);
    items.push({
      group: "Spin purchases (APE on ApeChain)",
      label: "Treasury wallet (receives APE)",
      ok: isAddr(pc?.treasury),
      detail:
        pc?.treasury && isAddr(pc.treasury)
          ? pc.treasury
          : "Not set — use a regular wallet address, not a Safe/contract",
      where: "Admin → Configuration → purchase → treasury",
    });
    items.push({
      group: "Spin purchases (APE on ApeChain)",
      label: "Price per spin",
      ok: price > 0,
      detail:
        price > 0
          ? pc?.price_usd_per_spin
            ? `$${price} USD in APE per spin`
            : `${price} APE per spin`
          : "Not set",
      where: "Admin → Configuration → purchase → price_usd_per_spin",
    });
    const [gate] = await sdb.rpc<{ ok: boolean; reason: string | null }>("purchase_gate", {
      _quantity: 5,
    });
    items.push({
      group: "Spin purchases (APE on ApeChain)",
      label: "Reserves cover worst-case prize obligations",
      ok: !!gate?.ok,
      detail: gate?.ok ? "OK" : (gate?.reason ?? "Unknown"),
      where: "Admin → Economics → Reserves",
    });
    items.push({
      group: "Sign-in (Privy)",
      label: "Privy App ID",
      ok: !!pc?.privy_app_id,
      detail: pc?.privy_app_id
        ? "Set"
        : "Not set — sign-in falls back to email/password and only browser-extension wallets can pay",
      where:
        "dashboard.privy.io → App settings → App ID → Admin → Configuration → purchase → privy_app_id. In Privy also: add your published + preview domains under Allowed origins; turn on Email, Google and Wallet login; turn on Ethereum embedded wallets",
    });
    const privySecret = !!process.env["PRIVY_APP_SECRET"];
    const firecrawl = !!process.env["FIRECRAWL_API_KEY"];
    const { data: ekRows } = await db
      .from("event_knowledge")
      .select("fetched_at")
      .order("fetched_at", { ascending: false })
      .limit(1);
    const lastFetch = (ekRows?.[0]?.fetched_at as string | undefined) ?? null;
    items.push({
      group: "Guide: ApeFest 2026 info",
      label: "Firecrawl API key (secret)",
      ok: firecrawl,
      detail: firecrawl
        ? `Set${lastFetch ? ` · BAYC pages last fetched ${new Date(lastFetch).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : " · not fetched yet (use “Refresh ApeFest info” below)"}`
        : "Not set — the guide only knows the basic event facts",
      where:
        "Lovable → Connectors → Firecrawl (sets FIRECRAWL_API_KEY), or firecrawl.dev → API keys → Lovable → Cloud → Secrets → FIRECRAWL_API_KEY",
    });
    items.push({
      group: "Sign-in (Privy)",
      label: "Privy App Secret (secret)",
      ok: privySecret,
      detail: privySecret ? "Set" : "Not set — Privy sign-in can't finish without it",
      where:
        "dashboard.privy.io → App settings → API keys → App secret → Lovable → Cloud → Secrets → PRIVY_APP_SECRET",
    });
    items.push({
      group: "Spin purchases (APE on ApeChain)",
      label: "Purchases switched on",
      ok: !!pc?.enabled,
      detail: pc?.enabled ? "On" : "Off — Refill shows “purchases open soon”",
      where: "Admin → Configuration → purchase → enabled: true (last step; not done automatically)",
    });
    return items;
  });

// ---------- Privy sign-in & default wallet ----------
// Privy is the sign-in window (email, Google or wallet) and creates an embedded wallet for players who
// don't have one. The server verifies the Privy session, maps it to a Supabase account (same Privy login,
// same verified email, or same linked wallet — all must agree) and hands back a one-time token the browser
// swaps for a normal Supabase session. Accounts are never merged automatically.

/** Public, non-secret bits the sign-in window needs before anyone is signed in. */
export const getPrivyPublicConfig = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = (await getConfig("purchase").catch(() => null)) as
    import("./purchase.server").PurchaseConfig | null;
  return {
    privy_app_id: cfg?.privy_app_id?.trim() || null,
    chain_id: cfg?.chain_id ?? 33139,
    rpc_url: cfg?.rpc_url ?? "https://rpc.apechain.com/http",
    explorer_url: cfg?.explorer_url ?? null,
  };
});

async function privyIdentityFromToken(accessToken: string) {
  const cfg = (await getConfig("purchase").catch(() => null)) as
    import("./purchase.server").PurchaseConfig | null;
  const appId = cfg?.privy_app_id?.trim();
  if (!appId) throw new Error("Privy sign-in isn't set up yet.");
  const privy = await import("./privy.server");
  const did = await privy.verifyPrivyAccessToken(accessToken, appId);
  return privy.fetchPrivyIdentity(did, appId);
}

/** Adds the player's Privy-verified wallets; wallets owned by another player are skipped (never moved). */
async function syncPrivyWallets(userId: string, identity: import("./privy.server").PrivyIdentity) {
  const sdb = await (await ctx()).serviceDb();
  const skipped: string[] = [];
  for (const w of identity.wallets) {
    try {
      await sdb.rpc("link_privy_wallet", { _user_id: userId, _address: w.address, _kind: w.kind });
    } catch {
      skipped.push(w.address);
    }
  }
  const db = await admin();
  const { data: mine } = await db
    .from("wallets")
    .select("address, kind, is_default, verified_at")
    .eq("user_id", userId)
    .order("verified_at");
  const rows = (mine ?? []) as { address: string; kind: string; is_default: boolean }[];
  if (rows.length && !rows.some((r) => r.is_default)) {
    const pick =
      rows.find((r) => r.kind === "privy") ??
      rows.find((r) => identity.wallets.some((w) => w.address === r.address)) ??
      rows[0]!;
    await sdb.rpc("set_default_wallet", { _user_id: userId, _address: pick.address });
  }
  return { skipped };
}

export const privySignIn = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const privy = await import("./privy.server");
    const db = await admin();
    const sdb = await (await ctx()).serviceDb();

    const byDid =
      ((
        await db
          .from("privy_accounts")
          .select("user_id")
          .eq("privy_did", identity.did)
          .maybeSingle()
      ).data?.user_id as string | undefined) ?? null;
    let byEmail: string | null = null;
    if (identity.email) {
      const { data: id } = await db.rpc("user_id_by_email", { _email: identity.email });
      byEmail = (id as string | null) ?? null;
    }
    let byWallets: string[] = [];
    if (identity.wallets.length) {
      const { data: ws } = await db
        .from("wallets")
        .select("user_id")
        .in(
          "address",
          identity.wallets.map((x) => x.address),
        );
      byWallets = [...new Set(((ws ?? []) as { user_id: string }[]).map((w) => w.user_id))];
    }
    let userId = privy.resolvePrivyUser({ byDid, byEmail, byWallets });

    let email: string | null = null;
    if (userId) {
      const { data: u } = await db.auth.admin.getUserById(userId);
      email = u?.user?.email ?? null;
      if (!email) {
        email =
          identity.email ??
          `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
        await db.auth.admin.updateUserById(userId, { email, email_confirm: true });
      }
    } else {
      // New player. Wallet-only sign-ins get a placeholder address; no email is ever sent to it.
      email =
        identity.email ??
        `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
      const { data: created, error } = await db.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { privy_did: identity.did },
      });
      if (error || !created?.user)
        throw new Error(error?.message ?? "Couldn't create your account");
      userId = created.user.id as string;
      await audit(userId, "user.created", { via: "privy" });
    }

    await sdb.rpc("link_privy_account", { _user_id: userId, _privy_did: identity.did });
    await syncPrivyWallets(userId!, identity);

    const { data: link, error: linkError } = await db.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHash = link?.properties?.hashed_token as string | undefined;
    if (linkError || !tokenHash)
      throw new Error(linkError?.message ?? "Couldn't start your session");
    await audit(userId!, "user.signed_in", { via: "privy" });
    return { tokenHash };
  });

/** A signed-in player who also signs in to Privy (e.g. to pay): attach that Privy login and its wallets. */
export const linkPrivyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data, context }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const sdb = await (await ctx()).serviceDb();
    try {
      await sdb.rpc("link_privy_account", { _user_id: context.userId, _privy_did: identity.did });
    } catch {
      throw new Error(
        "That Privy login belongs to another player. Sign out and sign in with it instead.",
      );
    }
    const { skipped } = await syncPrivyWallets(context.userId, identity);
    return { skipped };
  });

/** Account preferences: choose which linked wallet is the default (used to pay for spins). */
export const setDefaultWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: ADDRESS }).parse(d))
  .handler(async ({ data, context }) => {
    const sdb = await (await ctx()).serviceDb();
    const [w] = await sdb.rpc<{ address: string }>("set_default_wallet", {
      _user_id: context.userId,
      _address: data.address.toLowerCase(),
    });
    return { address: w!.address };
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
    const { data } = await db
      .from("event_knowledge")
      .select("url, title, source, fetched_at")
      .order("fetched_at", { ascending: false });
    return {
      ...r,
      pages: (data ?? []) as {
        url: string;
        title: string | null;
        source: string;
        fetched_at: string;
      }[],
    };
  });

export const adminEventInfoPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data } = await db
      .from("event_knowledge")
      .select("url, title, source, fetched_at")
      .order("fetched_at", { ascending: false });
    return (data ?? []) as {
      url: string;
      title: string | null;
      source: string;
      fetched_at: string;
    }[];
  });
