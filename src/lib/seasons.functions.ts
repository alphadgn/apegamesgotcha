// Seasons, leaderboards, player score breakdown, and admin season / ledger controls.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
const intStr = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);

/** Published seasons (draft seasons are never public). */
export const getSeasons = createServerFn({ method: "GET" }).handler(async () => {
  const h = await import("./helpers.server");
  const db = await h.adminDb();
  const { data, error } = await db.rpc("get_public_seasons");
  if (error) throw new Error(error.message);
  return (data ?? []) as {
    id: string;
    slug: string;
    name: string;
    status: "active" | "settling" | "finalized";
    is_legacy: boolean;
    starts_at: string | null;
    ends_at: string | null;
    settlement_deadline: string | null;
    grace_hours: number;
    rules: import("@/integrations/supabase/types").Json;
    rules_version: number;
    rules_hash: string | null;
    standings_version: number | null;
    standings_export_hash: string | null;
    finalized_at: string | null;
  }[];
});

export const getLeaderboardPage = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        slug,
        offset: z.number().int().min(0).max(1_000_000),
        limit: z.number().int().min(1).max(100),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const { data: rows, error } = await db.rpc("get_season_leaderboard", {
      _slug: data.slug,
      _offset: data.offset,
      _limit: data.limit,
    });
    if (error) throw new Error(error.message); // surfaced to the UI: never shown as an empty ranking
    const list = (rows ?? []) as {
      rank: string;
      public_id: string;
      alias: string | null;
      avatar_key: string | null;
      total_points: string;
      nft_points: string;
      participation_points: string;
      prize_points: string;
      social_points: string;
      adjustment_points: string;
      total_reached_at: string | null;
      total_count: string;
      standings_version: number | null;
    }[];
    return {
      rows: list.map((r) => ({ ...r, rank: String(r.rank) })),
      total: list[0] ? Number(list[0].total_count) : 0,
    };
  });

/** The signed-in player's place and breakdown in a season (via auth.uid() in the database). */
export type MyStanding = {
  rank: string;
  players: string;
  total_points: string;
  nft_points: string;
  participation_points: string;
  prize_points: string;
  social_points: string;
  adjustment_points: string;
  total_reached_at: string | null;
};
export type MyLedgerEntry = {
  id: string;
  amount: string;
  reward_subtype: string;
  source_type: string;
  source_id: string;
  effective_at: string;
  created_at: string;
  reverses_id: string | null;
  reversal_reason: string | null;
};
export type OpsAlert = {
  id: string;
  kind: string;
  subject: string;
  severity: string;
  message: string;
  occurrences: string;
  last_seen: string;
  resolved_at: string | null;
};

export const getMyStanding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ slug }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.rpc("get_my_season_standing", {
      _slug: data.slug,
    });
    if (error) throw new Error(error.message);
    const r = (rows as unknown as Record<string, unknown>[] | null)?.[0];
    if (!r) return null;
    const s = (k: string) => String(r[k] ?? "0");
    const standing: MyStanding = {
      rank: s("rank"),
      players: s("players"),
      total_points: s("total_points"),
      nft_points: s("nft_points"),
      participation_points: s("participation_points"),
      prize_points: s("prize_points"),
      social_points: s("social_points"),
      adjustment_points: s("adjustment_points"),
      total_reached_at: r["total_reached_at"] == null ? null : String(r["total_reached_at"]),
    };
    return standing;
  });

/** Dashboard: own ledger for a season (newest first). */
export const getMyLedger = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ slug, limit: z.number().int().min(1).max(200).default(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const { data: s } = await db
      .from("seasons")
      .select("id")
      .eq("slug", data.slug)
      .neq("status", "draft")
      .maybeSingle();
    if (!s) return [];
    const { data: rows, error } = await db
      .from("points_ledger")
      .select(
        "id, amount, reward_subtype, source_type, source_id, effective_at, created_at, reverses_id, reversal_reason",
      )
      .eq("season_id", s.id)
      .eq("user_id", context.userId)
      .order("id", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Record<string, unknown>[]).map((r): MyLedgerEntry => ({
      id: String(r["id"]),
      amount: String(r["amount"]),
      reward_subtype: String(r["reward_subtype"]),
      source_type: String(r["source_type"]),
      source_id: String(r["source_id"]),
      effective_at: String(r["effective_at"]),
      created_at: String(r["created_at"]),
      reverses_id: r["reverses_id"] == null ? null : String(r["reverses_id"]),
      reversal_reason: r["reversal_reason"] == null ? null : String(r["reversal_reason"]),
    }));
  });

// ---------------------------------------------------------------- admin

async function admin(userId: string) {
  const h = await import("./helpers.server");
  await h.assertAdmin(userId);
  return h;
}

export const adminListSeasons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { data, error } = await db
      .from("seasons")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const out = [];
    for (const s of data ?? []) {
      const [errs, unresolved, versions] = await Promise.all([
        s.status === "draft"
          ? h.rpc<string[]>("season_activation_errors", { _season: s.id })
          : Promise.resolve([] as string[]),
        s.status === "draft"
          ? Promise.resolve(null)
          : h.rpc("season_unresolved", { _season: s.id }),
        db
          .from("season_standings_versions")
          .select(
            "version, export_hash, ledger_watermark, finalized_at, supersedes_version, correction_reason",
          )
          .eq("season_id", s.id)
          .order("version"),
      ]);
      out.push({ ...s, activation_errors: errs, unresolved, versions: versions.data ?? [] });
    }
    return out;
  });

const rulesSchema = z.object({
  schema: z.literal(1),
  points: z.object({
    nft_snapshot_per_token: intStr,
    participation_per_spin: intStr,
    rarity_bonus: z.object({ common: intStr, rare: intStr, epic: intStr, legendary: intStr }),
    prize_bonus_overrides: z.record(z.string().uuid(), intStr),
    x_share: intStr,
  }),
  limits: z.object({
    spins_rolling_24h: z.number().int().min(1).max(9999),
    spins_per_season: z.number().int().min(1).max(999999),
    x_shares_per_utc_day: z.number().int().min(0).max(9),
  }),
  eligible_credit_sources: z.array(z.enum(["purchase", "burn", "grant", "free_entry"])),
  referrals_enabled: z.literal(false),
  historical_backfill_enabled: z.boolean(),
});

/** Create or edit a DRAFT season (frozen seasons are refused by the database). */
export const adminSaveSeasonDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        slug,
        name: z.string().min(1).max(80),
        starts_at: z.string().datetime().nullable(),
        ends_at: z.string().datetime().nullable(),
        settlement_deadline: z.string().datetime().nullable(),
        grace_hours: z.number().int().min(0).max(720),
        rules: rulesSchema,
        collection_ids: z.array(z.string().uuid()).max(10),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const row = {
      slug: data.slug,
      name: data.name,
      starts_at: data.starts_at,
      ends_at: data.ends_at,
      settlement_deadline: data.settlement_deadline,
      grace_period: `${data.grace_hours} hours`,
      rules: data.rules,
      snapshot_config: { collection_ids: data.collection_ids },
    };
    const res = data.id
      ? await db
          .from("seasons")
          .update(row)
          .eq("id", data.id)
          .eq("status", "draft")
          .select("id")
          .maybeSingle()
      : await db
          .from("seasons")
          .insert({ ...row, created_by: context.userId })
          .select("id")
          .single();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw new Error("Only draft seasons can be edited");
    await h.audit(context.userId, data.id ? "season.draft_updated" : "season.draft_created", {
      id: res.data.id,
      slug: data.slug,
    });
    return { id: res.data.id as string };
  });

export const adminDefaultRules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await admin(context.userId);
    return h.rpc("default_season_rules");
  });

export const adminSeasonAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum([
          "activate",
          "advance",
          "finalize",
          "backfill_report",
          "backfill_apply",
          "delete_draft",
          "extend_deadline",
        ]),
        deadline: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    switch (data.action) {
      case "activate":
        return h.rpc("activate_season", { _season: data.id, _actor: context.userId });
      case "advance":
        return h.rpc("advance_seasons");
      case "finalize":
        return h.rpc("finalize_season", { _season: data.id, _actor: context.userId });
      case "backfill_report":
        return h.rpc("season_backfill_report", { _season: data.id });
      case "backfill_apply":
        return h.rpc("apply_season_backfill", { _season: data.id, _actor: context.userId });
      case "delete_draft": {
        const { error } = await db.from("seasons").delete().eq("id", data.id).eq("status", "draft");
        if (error) throw new Error(error.message);
        await h.audit(context.userId, "season.draft_deleted", { id: data.id });
        return { ok: true };
      }
      case "extend_deadline": {
        if (!data.deadline) throw new Error("Pick the new deadline");
        const { error } = await db
          .from("seasons")
          .update({ settlement_deadline: data.deadline })
          .eq("id", data.id);
        if (error) throw new Error(error.message);
        await h.audit(context.userId, "season.deadline_extended", {
          id: data.id,
          deadline: data.deadline,
        });
        return { ok: true };
      }
    }
  });

/** Formula-safe CSV of a season's standings (finalized version) or live ranking. */
export const adminSeasonCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ id: z.string().uuid(), version: z.number().int().min(1).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const header = [
      "rank",
      "public_id",
      "alias",
      "total",
      "nft",
      "participation",
      "prize",
      "social",
      "adjustment",
      "total_reached_at",
    ];
    let rows: unknown[][] = [];
    if (data.version) {
      const { data: st, error } = await db
        .from("season_standings")
        .select("*")
        .eq("season_id", data.id)
        .eq("version", data.version)
        .order("rank");
      if (error) throw new Error(error.message);
      const ids = (st ?? []).map((r: { user_id: string }) => r.user_id);
      const { data: profs } = ids.length
        ? await db.from("profiles").select("id, public_alias").in("id", ids)
        : { data: [] };
      const alias = new Map(
        ((profs ?? []) as { id: string; public_alias: string | null }[]).map((p) => [
          p.id,
          p.public_alias,
        ]),
      );
      rows = (st ?? []).map((r: Record<string, unknown>) => [
        r["rank"],
        r["public_id"],
        alias.get(r["user_id"] as string) ?? "",
        r["total_points"],
        r["nft_points"],
        r["participation_points"],
        r["prize_points"],
        r["social_points"],
        r["adjustment_points"],
        r["total_reached_at"],
      ]);
    } else {
      const { data: s } = await db.from("seasons").select("slug").eq("id", data.id).single();
      for (let off = 0; ; off += 100) {
        const { data: page, error } = await db.rpc("get_season_leaderboard", {
          _slug: s.slug,
          _offset: off,
          _limit: 100,
        });
        if (error) throw new Error(error.message);
        const p = (page ?? []) as Record<string, unknown>[];
        rows.push(
          ...p.map((r) => [
            r["rank"],
            r["public_id"],
            r["alias"] ?? "",
            r["total_points"],
            r["nft_points"],
            r["participation_points"],
            r["prize_points"],
            r["social_points"],
            r["adjustment_points"],
            r["total_reached_at"],
          ]),
        );
        if (p.length < 100) break;
      }
    }
    await h.audit(context.userId, "season.csv_exported", {
      id: data.id,
      version: data.version ?? "live",
      rows: rows.length,
    });
    return { csv: h.toCsv(header, rows) };
  });

// ---------------------------------------------------------------- admin ledger

/** Find a player by email or public id (admin only). */
export const adminFindPlayer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ q: z.string().min(3).max(200) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    let userId: string | null = null;
    if (data.q.includes("@"))
      userId = (await h.rpc<string | null>("user_id_by_email", { _email: data.q.trim() })) ?? null;
    else {
      const { data: p } = await db
        .from("profiles")
        .select("id")
        .eq("public_id", data.q.trim())
        .maybeSingle();
      userId = p?.id ?? null;
    }
    if (!userId) return null;
    const [{ data: p }, { data: w }, { data: scores }] = await Promise.all([
      db
        .from("profiles")
        .select("id, public_id, public_alias, display_name")
        .eq("id", userId)
        .single(),
      db
        .from("wallets")
        .select("address, is_default, kind, verification_method")
        .eq("user_id", userId),
      db.from("season_scores").select("season_id, total_points").eq("user_id", userId),
    ]);
    return {
      profile: p,
      wallets: w ?? [],
      scores: (scores ?? []).map((s: { season_id: string; total_points: unknown }) => ({
        ...s,
        total_points: String(s.total_points),
      })),
    };
  });

export const adminPlayerLedger = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ userId: z.string().uuid(), seasonId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { data: rows, error } = await db
      .from("points_ledger")
      .select("*")
      .eq("user_id", data.userId)
      .eq("season_id", data.seasonId)
      .order("id", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Record<string, unknown>[]).map((r): MyLedgerEntry => ({
      id: String(r["id"]),
      amount: String(r["amount"]),
      reward_subtype: String(r["reward_subtype"]),
      source_type: String(r["source_type"]),
      source_id: String(r["source_id"]),
      effective_at: String(r["effective_at"]),
      created_at: String(r["created_at"]),
      reverses_id: r["reverses_id"] == null ? null : String(r["reverses_id"]),
      reversal_reason: r["reversal_reason"] == null ? null : String(r["reversal_reason"]),
    }));
  });

export const adminReverseEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        ledgerId: z.string().regex(/^[0-9]+$/),
        amount: z
          .string()
          .regex(/^[1-9][0-9]{0,17}$/)
          .nullable(),
        reason: z.string().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const { data: row } = await (
      await h.adminDb()
    )
      .from("points_ledger")
      .select("season_id")
      .eq("id", data.ledgerId)
      .single();
    const { data: s } = await (
      await h.adminDb()
    )
      .from("seasons")
      .select("status")
      .eq("id", row.season_id)
      .single();
    if (s.status === "finalized") {
      return h.rpc("correct_finalized_season", {
        _season: row.season_id,
        _actor: context.userId,
        _reason: data.reason,
        _ops: [{ op: "reverse", ledger_id: data.ledgerId, amount: data.amount }],
      });
    }
    const id = await h.rpc("reverse_ledger_entry", {
      _ledger_id: data.ledgerId,
      _amount: data.amount,
      _reason: data.reason,
      _actor: context.userId,
    });
    return { ledger_id: String(id) };
  });

export const adminAdjustPoints = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        userId: z.string().uuid(),
        seasonId: z.string().uuid(),
        amount: intStr,
        reason: z.string().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const { data: s } = await (
      await h.adminDb()
    )
      .from("seasons")
      .select("status")
      .eq("id", data.seasonId)
      .single();
    if (s.status === "finalized") {
      return h.rpc("correct_finalized_season", {
        _season: data.seasonId,
        _actor: context.userId,
        _reason: data.reason,
        _ops: [{ op: "adjust", user_id: data.userId, amount: data.amount }],
      });
    }
    const id = await h.rpc("admin_adjust_points", {
      _season: data.seasonId,
      _user: data.userId,
      _amount: data.amount,
      _reason: data.reason,
      _actor: context.userId,
    });
    return { ledger_id: String(id) };
  });

export const adminAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ includeResolved: z.boolean().default(false) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    let q = db.from("ops_alerts").select("*").order("last_seen", { ascending: false }).limit(200);
    if (!data.includeResolved) q = q.is("resolved_at", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Record<string, unknown>[]).map((r): OpsAlert => ({
      id: String(r["id"]),
      kind: String(r["kind"]),
      subject: String(r["subject"] ?? ""),
      severity: String(r["severity"]),
      message: String(r["message"]),
      occurrences: String(r["occurrences"]),
      last_seen: String(r["last_seen"]),
      resolved_at: r["resolved_at"] == null ? null : String(r["resolved_at"]),
    }));
  });

export const adminResolveAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ kind: z.string().min(1).max(60), subject: z.string().max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    await h.rpc("resolve_alert", {
      _kind: data.kind,
      _subject: data.subject,
      _actor: context.userId,
    });
    await h.audit(context.userId, "alert.resolved", data);
    return { ok: true };
  });
