// Season leaderboard server functions: player actions (profile, snapshot claims, X shares) and
// admin operations (seasons, snapshots, share review, reversals, economics, operations, exports).
// Public standings are read straight from the read-only RPCs (list_seasons, get_season_leaderboard,
// get_season_rules, get_my_season_standing) — no server function needed for those.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "./db-rpc";

const ctx = () => import("./server-context.server");
const UUID = z.string().uuid();

async function sdb() {
  return (await ctx()).serviceDb();
}
async function raw() {
  return (await ctx()).adminClient();
}
async function assertAdmin(userId: string) {
  return (await ctx()).assertAdmin(userId);
}
function unwrap<T>(row: unknown, key: string): T {
  return (
    row && typeof row === "object" && key in (row as object)
      ? (row as Record<string, unknown>)[key]
      : row
  ) as T;
}

// =====================================================================================
// Player
// =====================================================================================

export const setPublicProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        alias: z.string().max(24).nullable(),
        avatarKey: z
          .string()
          .regex(/^[a-z0-9-]{1,32}$/)
          .nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await sdb();
    const [p] = await db.rpc<{
      public_id: string;
      public_alias: string | null;
      avatar_key: string | null;
    }>("set_public_profile", {
      _user_id: context.userId,
      _alias: data.alias,
      _avatar_key: data.avatarKey,
    });
    return p!;
  });

/** Open claims for the player's snapshot holdings and verify them at the snapshot block (archive RPC). */
export const claimSnapshotPoints = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await sdb();
    const snap = await import("./snapshot.server");
    const opened = await db.rpc<{ id: string }>("request_snapshot_claims", {
      _user_id: context.userId,
      _season_id: data.seasonId,
    });
    const r = await raw();
    const { data: open } = await r
      .from("nft_snapshot_claims")
      .select("id, collection_id, token_id, owner_address")
      .eq("user_id", context.userId)
      .eq("season_id", data.seasonId)
      .in("status", ["pending", "unavailable"])
      .limit(300);
    const byCollection = new Map<
      string,
      { id: string; collection_id: string; token_id: string; owner_address: string }[]
    >();
    for (const c of (open ?? []) as {
      id: string;
      collection_id: string;
      token_id: string;
      owner_address: string;
    }[]) {
      byCollection.set(c.collection_id, [...(byCollection.get(c.collection_id) ?? []), c]);
    }
    const cfg = (await (
      await ctx()
    )
      .readConfig<{ archive_rpc_by_chain?: Record<string, string> }>("snapshots")
      .catch(() => ({}))) as { archive_rpc_by_chain?: Record<string, string> };
    const totals = { opened: opened.length, verified: 0, rejected: 0, unavailable: 0 };
    for (const [cid, claims] of byCollection) {
      const [col] = await db.select<import("./snapshot.server").Collection>("nft_collections", {
        id: cid,
      });
      if (!col) continue;
      const out = await snap.verifyClaims(
        db,
        snap.archiveClient(col.chain_id, cfg.archive_rpc_by_chain),
        col,
        claims,
      );
      totals.verified += out.verified;
      totals.rejected += out.rejected;
      totals.unavailable += out.unavailable;
    }
    return totals;
  });

export const getShareSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await raw();
    const { data: season } = await r
      .from("seasons")
      .select("id, rules, starts_at, ends_at")
      .eq("status", "active")
      .maybeSingle();
    const rules = (season?.rules ?? {}) as {
      social_enabled?: boolean;
      social_share_points?: number;
    };
    const now = Date.now();
    const open =
      !!season && now >= Date.parse(season.starts_at) && now < Date.parse(season.ends_at);
    const { data: xa } = await r
      .from("x_accounts")
      .select("x_username, verification")
      .eq("user_id", context.userId)
      .is("unlinked_at", null)
      .maybeSingle();
    return {
      enabled: open && !!rules.social_enabled && Number(rules.social_share_points ?? 0) > 0,
      points: Number(rules.social_share_points ?? 0),
      xAccount: (xa as { x_username: string; verification: string } | null) ?? null,
      autoVerify: !!process.env["X_API_BEARER_TOKEN"],
    };
  });

export const linkXAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ username: z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await sdb();
    // Control of the account is proven per share: the post must come from this handle and show the spin's
    // private share code. We never ask for X passwords.
    const [a] = await db.rpc<{ x_username: string }>("link_x_account", {
      _user_id: context.userId,
      _username: data.username,
      _x_user_id: null,
      _verification: "self_declared",
      _evidence: {},
    });
    return { username: a!.x_username };
  });

export const submitShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ spinId: UUID, postUrl: z.string().url().max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await sdb();
    const social = await import("./social.server");
    if (!social.normalizeXPostUrl(data.postUrl))
      throw new Error("Paste the link to your post on x.com");
    const [share] = await db.rpc<{ id: string; post_id: string; status: string }>(
      "submit_social_share",
      {
        _user_id: context.userId,
        _spin_id: data.spinId,
        _post_url: data.postUrl,
      },
    );
    // Optional automatic verification through the X API; failures leave it pending for manual review.
    const ev = await social.fetchPostEvidence(share!.post_id, social.spinShareCode(data.spinId));
    if (ev) {
      const [reviewed] = await db
        .rpc<{ status: string }>("review_social_share", {
          _share_id: share!.id,
          _decision: "approve",
          _verifier: "x_api",
          _evidence: ev,
          _reason: null,
          _actor: null,
        })
        .catch(() => [share!]);
      return { id: share!.id, status: reviewed!.status };
    }
    return { id: share!.id, status: share!.status };
  });

// =====================================================================================
// Admin
// =====================================================================================

export const adminListSeasons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const db = await sdb();
    const { data, error } = await r
      .from("seasons")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const { data: links } = await r.from("season_collections").select("season_id, collection_id");
    const out = [];
    for (const s of (data ?? []) as { id: string; status: string; is_legacy: boolean }[]) {
      const unresolved = s.is_legacy
        ? []
        : await db.rpc<{ kind: string; item_count: string }>("season_unresolved_items", {
            _season_id: s.id,
          });
      out.push({
        ...s,
        collections: ((links ?? []) as { season_id: string; collection_id: string }[])
          .filter((l) => l.season_id === s.id)
          .map((l) => l.collection_id),
        unresolved: unresolved.filter((u) => Number(u.item_count) > 0),
      });
    }
    return out;
  });

const seasonDraft = z.object({
  name: z.string().min(2).max(80),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  settlementDeadline: z.string().datetime({ offset: true }).nullable(),
  rules: z.record(z.any()),
  notes: z.string().max(1000).nullable(),
});

export const adminCreateSeasonDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    seasonDraft.extend({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const [s] = await (
      await sdb()
    ).rpc<{ id: string }>("create_season_draft", {
      _slug: data.slug,
      _name: data.name,
      _starts_at: data.startsAt,
      _ends_at: data.endsAt,
      _settlement_deadline: data.settlementDeadline,
      _rules: data.rules,
      _notes: data.notes,
      _actor: context.userId,
    });
    return { id: s!.id };
  });

export const adminUpdateSeasonDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => seasonDraft.extend({ id: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await (
      await sdb()
    ).rpc("update_season_draft", {
      _season_id: data.id,
      _name: data.name,
      _starts_at: data.startsAt,
      _ends_at: data.endsAt,
      _settlement_deadline: data.settlementDeadline,
      _rules: data.rules,
      _notes: data.notes,
      _actor: context.userId,
    });
    return { ok: true };
  });

export const adminSetSeasonCollections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ seasonId: UUID, collectionIds: z.array(UUID).max(20) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await (
      await sdb()
    ).rpc("set_season_collections", {
      _season_id: data.seasonId,
      _collection_ids: data.collectionIds,
      _actor: context.userId,
    });
    return { ok: true };
  });

/** Deliberate admin action: freezes rules + snapshot configuration. The UI asks for typed confirmation. */
export const adminActivateSeason = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID, confirmSlug: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const { data: s } = await r
      .from("seasons")
      .select("slug")
      .eq("id", data.seasonId)
      .maybeSingle();
    if (!s || s.slug !== data.confirmSlug)
      throw new Error("Type the season slug to confirm activation");
    await (
      await sdb()
    ).rpc("activate_season", { _season_id: data.seasonId, _actor: context.userId });
    return { ok: true };
  });

export const adminFinalizeSeason = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const db = await sdb();
    await db.rpc("advance_season_states", {});
    const [v] = await db.rpc<{ version: number; export_hash: string }>("finalize_season", {
      _season_id: data.seasonId,
      _actor: context.userId,
    });
    return v!;
  });

export const adminSupersedeStandings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID, reason: z.string().min(5).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const [v] = await (
      await sdb()
    ).rpc<{ version: number; export_hash: string }>("supersede_final_standings", {
      _season_id: data.seasonId,
      _reason: data.reason,
      _actor: context.userId,
    });
    return v!;
  });

export const adminBackfillReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const [r] = await (await sdb()).rpc("season_backfill_report", { _season_id: data.seasonId });
    return unwrap<{ [key: string]: Json }>(r, "season_backfill_report");
  });

/** Formula-safe CSV of a finalized standings version (or live ranking when not finalized). */
export const adminExportStandingsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ seasonId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { csvCell } = await ctx();
    const db = await sdb();
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await db.rpc<Record<string, unknown>>("get_season_leaderboard", {
        _season_id: data.seasonId,
        _limit: 100,
        _offset: offset,
      });
      rows.push(...page);
      if (page.length < 100) break;
    }
    const cols = [
      "rank",
      "public_id",
      "alias",
      "total_points",
      "nft_points",
      "participation_points",
      "prize_points",
      "social_points",
      "adjustment_points",
      "legacy_points",
      "standings_version",
      "is_final",
    ];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join(
      "\n",
    );
    await (
      await ctx()
    ).audit(context.userId, "season.exported", { seasonId: data.seasonId, rows: rows.length });
    return { csv, rows: rows.length };
  });

// ---------- Snapshots ----------
export const adminListCollections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await (
      await raw()
    )
      .from("nft_collections")
      .select("*")
      .order("created_at");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const adminUpsertCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: UUID.optional(),
        chainId: z.number().int().positive(),
        contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        edition: z.string().min(1).max(40),
        name: z.string().min(2).max(80),
        snapshotBlock: z.number().int().positive().nullable(),
        snapshotBlockHash: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .nullable(),
        indexFromBlock: z.number().int().min(0),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const row = {
      chain_id: data.chainId,
      contract: data.contract.toLowerCase(),
      edition: data.edition,
      name: data.name,
      snapshot_block: data.snapshotBlock,
      snapshot_block_hash: data.snapshotBlockHash?.toLowerCase() ?? null,
      index_from_block: data.indexFromBlock,
    };
    if (data.id) {
      const { data: cur } = await r
        .from("nft_collections")
        .select("status, snapshot_block, snapshot_block_hash, index_from_block")
        .eq("id", data.id)
        .single();
      if (cur?.status !== "candidate") throw new Error("Only candidate collections can be edited");
      const anchorChanged =
        cur.snapshot_block !== data.snapshotBlock ||
        cur.snapshot_block_hash !== row.snapshot_block_hash ||
        Number(cur.index_from_block) !== data.indexFromBlock;
      if (anchorChanged)
        await (
          await sdb()
        ).rpc("reset_snapshot_index", { _collection_id: data.id, _actor: context.userId });
      const { error } = await r.from("nft_collections").update(row).eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await r.from("nft_collections").insert(row);
      if (error) throw new Error(error.message);
    }
    await (await ctx()).audit(context.userId, "snapshot.collection_saved", row);
    return { ok: true };
  });

export const adminIndexCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const snap = await import("./snapshot.server");
    const db = await sdb();
    const [col] = await db.select<import("./snapshot.server").Collection>("nft_collections", {
      id: data.id,
    });
    if (!col) throw new Error("Unknown collection");
    const cfg = (await (
      await ctx()
    )
      .readConfig<{ archive_rpc_by_chain?: Record<string, string> }>("snapshots")
      .catch(() => ({}))) as { archive_rpc_by_chain?: Record<string, string> };
    const pub = snap.archiveClient(col.chain_id, cfg.archive_rpc_by_chain);
    if (!pub) throw new Error(`Set the ARCHIVE_RPC_URL_${col.chain_id} secret first`);
    return snap.indexSnapshot(db, pub, col, { maxRanges: 40 });
  });

export const adminVerifyCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: UUID, evidence: z.string().min(10).max(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await (
      await sdb()
    ).rpc("verify_nft_collection", {
      _collection_id: data.id,
      _evidence: data.evidence,
      _actor: context.userId,
    });
    return { ok: true };
  });

// ---------- Shares ----------
export const adminShareQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const { data, error } = await r
      .from("social_shares")
      .select("id, post_id, spin_id, status, submitted_at, award_day, x_account_id")
      .eq("status", "pending")
      .order("submitted_at")
      .limit(100);
    if (error) throw new Error(error.message);
    const accounts = new Map<string, string>();
    const ids = [
      ...new Set(((data ?? []) as { x_account_id: string }[]).map((s) => s.x_account_id)),
    ];
    if (ids.length) {
      const { data: xs } = await r.from("x_accounts").select("id, x_username").in("id", ids);
      for (const x of (xs ?? []) as { id: string; x_username: string }[])
        accounts.set(x.id, x.x_username);
    }
    const social = await import("./social.server");
    return (
      (data ?? []) as {
        id: string;
        post_id: string;
        spin_id: string;
        status: string;
        submitted_at: string;
        award_day: string;
        x_account_id: string;
      }[]
    ).map((s) => ({
      ...s,
      username: accounts.get(s.x_account_id) ?? "?",
      shareCode: social.spinShareCode(s.spin_id),
      postUrl: `https://x.com/i/web/status/${s.post_id}`,
    }));
  });

export const adminReviewShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        shareId: UUID,
        decision: z.enum(["approve", "reject"]),
        authorUsername: z.string().max(15).optional(),
        postCreatedAt: z.string().datetime({ offset: true }).optional(),
        referencesSpin: z.boolean().optional(),
        isPublic: z.boolean().optional(),
        reason: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const evidence =
      data.decision === "approve"
        ? {
            author_username: data.authorUsername,
            post_created_at: data.postCreatedAt,
            references_spin: !!data.referencesSpin,
            public: !!data.isPublic,
            source: "manual_review",
            reviewed_by: context.userId,
          }
        : { source: "manual_review" };
    const [s] = await (
      await sdb()
    ).rpc<{ status: string }>("review_social_share", {
      _share_id: data.shareId,
      _decision: data.decision,
      _verifier: "manual_review",
      _evidence: evidence,
      _reason: data.reason ?? null,
      _actor: context.userId,
    });
    return { status: s!.status };
  });

// ---------- Ledger corrections ----------
export const adminLedgerLookup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ email: z.string().email(), seasonId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const { data: uid, error: e1 } = await r.rpc("user_id_by_email", { _email: data.email });
    if (e1) throw new Error(e1.message);
    if (!uid) throw new Error("No player with that email");
    const { data: rows, error } = await r
      .from("points_ledger")
      .select(
        "id, amount, reward_subtype, source_type, source_id, reverses_id, reversal_reason, effective_at",
      )
      .eq("user_id", uid)
      .eq("season_id", data.seasonId)
      .order("id", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Record<string, unknown>[]).map((x) => ({
      ...x,
      id: String(x["id"]),
      amount: String(x["amount"]),
      reverses_id: x["reverses_id"] == null ? null : String(x["reverses_id"]),
    }));
  });

export const adminReversePoints = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        ledgerId: z.string().regex(/^\d+$/),
        amount: z.string().regex(/^\d+$/).nullable(),
        reason: z.string().min(5).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await (
      await sdb()
    ).rpc("reverse_points", {
      _ledger_id: data.ledgerId,
      _amount: data.amount,
      _reason: data.reason,
      _actor: context.userId,
    });
    return { ok: true };
  });

// ---------- Economics ----------
export const adminEconomics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const db = await sdb();
    const r = await raw();
    const [st] = await db.rpc("economic_status", {});
    const [{ data: costs }, { data: prizes }, { data: econ }, { data: reserves }] =
      await Promise.all([
        r.from("operating_costs").select("*").is("retired_at", null).order("created_at"),
        r
          .from("prizes")
          .select("id, name, rarity, weight, inventory, active, fulfillment_type, onchain_index")
          .order("created_at"),
        r.from("prize_economics").select("*"),
        r.from("reserve_entries").select("*").order("created_at", { ascending: false }).limit(50),
      ]);
    return {
      status: unwrap<{ [key: string]: Json }>(st, "economic_status"),
      costs: (costs ?? []) as { [key: string]: Json }[],
      prizes: (prizes ?? []) as { [key: string]: Json }[],
      prizeEconomics: (econ ?? []) as { [key: string]: Json }[],
      reserves: (reserves ?? []) as { [key: string]: Json }[],
    };
  });

export const adminRecordCost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        category: z.enum(["gas", "vrf", "provider", "hosting", "support", "other"]),
        basis: z.enum(["per_spin", "per_draw", "monthly", "one_time"]),
        description: z.string().min(3).max(200),
        amountUsd: z.number().min(0).nullable(),
        evidence: z.string().min(3).max(500).nullable(),
        retireId: UUID.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    if (data.retireId)
      await r
        .from("operating_costs")
        .update({ retired_at: new Date().toISOString() })
        .eq("id", data.retireId);
    const { error } = await r.from("operating_costs").insert({
      category: data.category,
      basis: data.basis,
      description: data.description,
      amount_usd: data.amountUsd,
      verified_at: data.amountUsd == null ? null : new Date().toISOString(),
      evidence: data.evidence,
      recorded_by: context.userId,
    });
    if (error) throw new Error(error.message);
    await (await ctx()).audit(context.userId, "economics.cost_recorded", data);
    return { ok: true };
  });

export const adminSavePrizeEconomics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        prizeId: UUID,
        acquisitionUsd: z.number().min(0).nullable(),
        fulfillmentUsd: z.number().min(0).nullable(),
        shippingUsd: z.number().min(0).nullable(),
        costEvidence: z.string().max(500).nullable(),
        stockVerifiedQty: z.number().int().min(0).nullable(),
        stockEvidence: z.string().max(500).nullable(),
        fundingReservedUsd: z.number().min(0),
        fundingEvidence: z.string().max(500).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const now = new Date().toISOString();
    const costsKnown =
      data.acquisitionUsd != null &&
      data.fulfillmentUsd != null &&
      data.shippingUsd != null &&
      !!data.costEvidence;
    const { error } = await (await raw()).from("prize_economics").upsert({
      prize_id: data.prizeId,
      acquisition_usd: data.acquisitionUsd,
      fulfillment_usd: data.fulfillmentUsd,
      shipping_usd: data.shippingUsd,
      cost_verified_at: costsKnown ? now : null,
      cost_evidence: data.costEvidence,
      stock_verified_qty: data.stockVerifiedQty,
      stock_verified_at: data.stockVerifiedQty != null && data.stockEvidence ? now : null,
      stock_evidence: data.stockEvidence,
      funding_reserved_usd: data.fundingReservedUsd,
      funding_verified_at: data.fundingReservedUsd > 0 && data.fundingEvidence ? now : null,
      funding_evidence: data.fundingEvidence,
      updated_at: now,
      updated_by: context.userId,
    });
    if (error) throw new Error(error.message);
    await (await ctx()).audit(context.userId, "economics.prize_saved", data);
    return { ok: true };
  });

export const adminRecordReserve = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        amountUsd: z.number().refine((n) => n !== 0),
        evidence: z.string().min(5).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { error } = await (
      await raw()
    )
      .from("reserve_entries")
      .insert({ amount_usd: data.amountUsd, evidence: data.evidence, recorded_by: context.userId });
    if (error) throw new Error(error.message);
    await (await ctx()).audit(context.userId, "economics.reserve_recorded", data);
    return { ok: true };
  });

export const adminSaveBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: UUID.optional(),
        source: z.enum(["burn", "grant", "free_entry"]),
        name: z.string().min(2).max(80),
        fundedUsd: z.number().positive(),
        pauseThresholdUsd: z.number().min(0),
        evidence: z.string().min(5).max(500),
        active: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const r = await raw();
    const row = {
      source: data.source,
      name: data.name,
      funded_usd: data.fundedUsd,
      pause_threshold_usd: data.pauseThresholdUsd,
      evidence: data.evidence,
      active: data.active,
    };
    const { error } = data.id
      ? await r.from("sponsored_budgets").update(row).eq("id", data.id)
      : await r.from("sponsored_budgets").insert({ ...row, created_by: context.userId });
    if (error) throw new Error(error.message);
    await (await ctx()).audit(context.userId, "economics.budget_saved", data);
    return { ok: true };
  });

// ---------- Operations ----------
export const adminOps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const db = await sdb();
    const alerts = await db.rpc<{ [key: string]: Json }>("ops_monitor_scan", {});
    const queue = await db.rpc<{ [key: string]: Json }>("open_draw_work", { _limit: 100 });
    const r = await raw();
    const { data: conflicts } = await r
      .from("draw_batches")
      .select("id, status, last_error, created_at, spin_count, request_tx")
      .eq("status", "conflict")
      .limit(50);
    return { alerts, queue: [...queue, ...((conflicts ?? []) as { [key: string]: Json }[])] };
  });

export const adminResolveAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ alertId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await (
      await sdb()
    ).rpc("resolve_ops_alert", { _alert_id: data.alertId, _actor: context.userId });
    return { ok: true };
  });

/** Re-check a conflicted batch on-chain and resolve it with the gathered evidence. */
export const adminResolveConflict = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ batchId: UUID, resolution: z.enum(["confirmed", "not_onchain"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const draws = await import("./draws.server");
    const cfg = await (await ctx()).readConfig<import("./vrf.server").VrfConfig>("vrf");
    const deps = await (await ctx()).drawDeps(cfg);
    const db = deps.db;
    const [b] = await db.select<import("./draws.server").DrawBatch>("draw_batches", {
      id: data.batchId,
    });
    if (!b) throw new Error("Unknown batch");
    const evidence: { [key: string]: Json } = await draws.gatherConflictEvidence(deps, b);
    if (
      data.resolution === "not_onchain" &&
      !(
        evidence["all_spins_none"] &&
        evidence["no_receipts"] &&
        evidence["nonce_consumed_by_other_tx_final"]
      )
    ) {
      throw new Error(
        "The chain doesn't prove this request can never be mined. Keep it reserved and check again later.",
      );
    }
    if (data.resolution === "confirmed" && evidence["all_spins_none"]) {
      throw new Error("The contract shows no request for these spins.");
    }
    await db.rpc("resolve_batch_conflict", {
      _batch_id: b.id,
      _resolution: data.resolution,
      _evidence: evidence,
      _actor: context.userId,
    });
    return evidence;
  });
