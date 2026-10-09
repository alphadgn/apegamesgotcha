// NFTs: live holdings display, burns for a sponsored spin, historical snapshot claims, admin collections.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Live holdings for display and burn eligibility only. Never awards points. */
export const syncNfts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    const { listOwnedTokens, fetchLevel } = await import("./nft.server");
    const db = await h.adminDb();
    const cfg = await h.getConfig<import("./nft.server").NftConfig>("nft");
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    let found = 0;
    for (const w of (wallets ?? []) as { address: string }[]) {
      const ids = await listOwnedTokens(cfg, w.address);
      for (const id of ids) {
        found++;
        const tokenId = id.toString();
        const { data: prev } = await db.from("nft_holdings").select("level, level_override, burned").eq("token_id", tokenId).maybeSingle();
        if (prev?.burned) continue;
        const level = prev?.level ?? (await fetchLevel(cfg, id));
        const { error } = await db.from("nft_holdings").upsert({ token_id: tokenId, owner_address: w.address, user_id: context.userId, level, synced_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
      }
    }
    await h.audit(context.userId, "nft.synced", { found });
    return { found, awarded: 0 };
  });

/** Burn a Level 4+ NFT for one sponsored spin. */
export const claimBurn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), tokenId: z.string().regex(/^\d{1,78}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const { verifyBurnTx, fetchLevel } = await import("./nft.server");
    const db = await h.adminDb();
    const cfg = await h.getConfig<import("./nft.server").NftConfig>("nft");
    const { data: wallets } = await db.from("wallets").select("address").eq("user_id", context.userId);
    if (!wallets?.length) throw new Error("Verify a wallet first");
    const burn = await verifyBurnTx(cfg, data.txHash as `0x${string}`, BigInt(data.tokenId), (wallets as { address: string }[]).map((w) => w.address));
    // Level from trusted pre-burn state: admin override, else the level recorded before the burn,
    // else the token's metadata read at the block BEFORE the burn.
    const { data: hold } = await db.from("nft_holdings").select("level, level_override, synced_at").eq("token_id", data.tokenId).maybeSingle();
    let level: number | null = null;
    let source = "";
    if (hold?.level_override != null) [level, source] = [hold.level_override, "admin_override"];
    else if (hold?.level != null) [level, source] = [hold.level, "recorded_before_burn"];
    else {
      level = await fetchLevel(cfg, BigInt(data.tokenId), BigInt(burn.blockNumber - 1));
      source = "token_uri_at_pre_burn_block";
    }
    if (level == null) throw new Error("Could not read this NFT's level before the burn. Ask an admin to verify it.");
    const r = await h.rpc<{ ok: boolean; reason?: string; claim_id?: string; credit_id?: string }>("record_burn_claim", {
      _user: context.userId,
      _chain_id: burn.chainId,
      _contract: burn.contract,
      _token_id: burn.tokenId,
      _tx_hash: burn.txHash,
      _log_index: burn.logIndex,
      _block_number: burn.blockNumber,
      _block_hash: burn.blockHash,
      _from: burn.from,
      _level: level,
      _level_source: source,
      _evidence: { verified_at: new Date().toISOString() },
    });
    if (!r.ok) throw new Error("Free spins for burns are paused right now (sponsored budget). Your burn stays claimable — try again later.");
    await h.audit(context.userId, "nft.burned", { ...data, level, source });
    return { ok: true };
  });

// ---------------------------------------------------------------- snapshot claims

/** Collections in the current season's snapshot, with the player's claim state. */
export const getSnapshotStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const { data: s } = await db.rpc("current_season");
    const season = s as { id: string | null; snapshot_config?: { collection_ids?: string[] }; rules?: { points?: { nft_snapshot_per_token?: string } } } | null;
    const ids = season?.id ? season.snapshot_config?.collection_ids ?? [] : [];
    const { data: cols } = ids.length ? await db.from("nft_collections").select("id, label, edition, chain_id, contract, snapshot_block, status").in("id", ids) : { data: [] };
    const { data: claims } = await db.from("nft_snapshot_claims").select("collection_id, status, token_id").eq("user_id", context.userId);
    const by = new Map<string, Record<string, number>>();
    for (const c of (claims ?? []) as { collection_id: string; status: string }[]) {
      const m = by.get(c.collection_id) ?? {};
      m[c.status] = (m[c.status] ?? 0) + 1;
      by.set(c.collection_id, m);
    }
    return {
      points_per_token: season?.id ? season.rules?.points?.nft_snapshot_per_token ?? "0" : "0",
      collections: ((cols ?? []) as { id: string }[]).map((c) => ({ ...c, claims: by.get(c.id) ?? {} })),
    };
  });

export const claimSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ collectionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const snap = await import("./snapshot.server");
    const r = await snap.claimForUser(context.userId, data.collectionId);
    await h.audit(context.userId, "snapshot.claimed", { collection: data.collectionId, ...r });
    return r;
  });

// ---------------------------------------------------------------- admin collections

export const adminCollections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const db = await h.adminDb();
    const { data, error } = await db.from("nft_collections").select("*").order("created_at");
    if (error) throw new Error(error.message);
    const out = [];
    for (const c of data ?? []) {
      const { count } = await db.from("nft_snapshot_owners").select("token_id", { count: "exact", head: true }).eq("collection_id", c.id);
      const { count: open } = await db.from("nft_snapshot_claims").select("id", { count: "exact", head: true }).eq("collection_id", c.id).in("status", ["pending", "unavailable"]);
      out.push({ ...c, indexed_tokens: count ?? 0, open_claims: open ?? 0 });
    }
    return out;
  });

export const adminSaveCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      id: z.string().uuid().optional(),
      label: z.string().min(1).max(80),
      edition: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
      chain_id: z.number().int().positive(),
      contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      deploy_block: z.number().int().min(0).nullable(),
      snapshot_block: z.number().int().min(0).nullable(),
      snapshot_block_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable(),
      notes: z.string().max(500).nullable(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const db = await h.adminDb();
    const row = { ...data, contract: data.contract.toLowerCase(), snapshot_block_hash: data.snapshot_block_hash?.toLowerCase() ?? null };
    delete (row as { id?: string }).id;
    const res = data.id
      ? await db.from("nft_collections").update(row).eq("id", data.id).neq("status", "ready").select("id").maybeSingle()
      : await db.from("nft_collections").insert(row).select("id").single();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw new Error("Ready collections are frozen");
    await h.audit(context.userId, "snapshot.collection_saved", row);
    return { id: res.data.id as string };
  });

export const adminIndexCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const snap = await import("./snapshot.server");
    return snap.indexCollectionChunk(data.id);
  });

/** Mark ready: the admin confirms this is the intended collection; the anchor is re-checked on-chain. */
export const adminMarkCollectionReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), confirm: z.literal(true) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const snap = await import("./snapshot.server");
    const db = await h.adminDb();
    const { data: c } = await db.from("nft_collections").select("*").eq("id", data.id).single();
    const client = await snap.archiveClient(c.chain_id);
    const anchor = await snap.checkSnapshotAnchor(client, c);
    if (!anchor.ok) throw new Error(anchor.reason);
    const { error } = await db.from("nft_collections").update({ status: "ready", verified_by: context.userId, verified_at: new Date().toISOString() }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await h.audit(context.userId, "snapshot.collection_ready", { id: data.id, snapshot_block: c.snapshot_block, hash: c.snapshot_block_hash });
    return { ok: true };
  });

/** Resolve a claim that can't be verified (e.g. permanent archive gap) as rejected, with a reason. */
export const adminRejectClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), reason: z.string().min(3).max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const db = await h.adminDb();
    const { data: cl } = await db.from("nft_snapshot_claims").select("collection_id").eq("id", data.id).single();
    const { data: c } = await db.from("nft_collections").select("snapshot_block_hash").eq("id", cl.collection_id).single();
    await h.rpc("record_snapshot_verification", { _claim: data.id, _owner: "0x0000000000000000000000000000000000000000", _block_hash: c.snapshot_block_hash, _unavailable: false, _error: null });
    await h.audit(context.userId, "snapshot.claim_rejected", data);
    return { ok: true };
  });
