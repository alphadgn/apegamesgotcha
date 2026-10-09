// Admin economic controls: prize classification and costs, operating costs, funding, sponsored
// budgets, stock, fulfillment and sponsored grants. Unknown costs stay "unverified", never zero.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const usd = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/);

async function admin(userId: string) {
  const h = await import("./helpers.server");
  await h.assertAdmin(userId);
  return h;
}

export const adminEconomics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const [status, { data: prizes }, { data: costs }, { data: funding }, { data: fulfill }] = await Promise.all([
      h.rpc("economics_status"),
      db.from("prizes").select("*").order("onchain_index", { nullsFirst: false }),
      db.from("operating_costs").select("*").order("key"),
      db.from("funding_events").select("*").order("id", { ascending: false }).limit(50),
      db.from("prize_fulfillments").select("*").order("created_at", { ascending: false }).limit(100),
    ]);
    return { status, prizes: prizes ?? [], costs: costs ?? [], funding: funding ?? [], fulfillments: fulfill ?? [] };
  });

export const adminSavePrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().min(1).max(100),
      rarity: z.enum(["common", "rare", "epic", "legendary"]),
      weight: z.number().int().min(0).max(4294967295),
      inventory: z.number().int().min(0).nullable(),
      active: z.boolean(),
      kind: z.enum(["points_only", "fulfillment_required"]),
      unit_cost_usd: usd.nullable(),
      cost_verified: z.boolean(),
      stock_verified: z.boolean(),
      economics_notes: z.string().max(500).nullable(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { id, ...rest } = data;
    if (rest.inventory == null && rest.kind !== "points_only") throw new Error("Real prizes need a finite stock");
    if (rest.cost_verified && rest.unit_cost_usd == null) throw new Error("A verified cost needs an amount");
    if (id) {
      // Stock changes go through audited stock adjustments, never a silent overwrite.
      const { data: cur } = await db.from("prizes").select("inventory").eq("id", id).single();
      if (cur && cur.inventory !== rest.inventory && cur.inventory != null && rest.inventory != null) {
        throw new Error("Use “Adjust stock” (audited) to change remaining stock");
      }
    }
    const { error } = id ? await db.from("prizes").update(rest).eq("id", id) : await db.from("prizes").insert(rest);
    if (error) throw new Error(error.message);
    await h.audit(context.userId, "prize.saved", data);
    return { ok: true };
  });

export const adminAdjustStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ prizeId: z.string().uuid(), delta: z.number().int().min(-100000).max(100000), reason: z.string().min(3).max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    return h.rpc("adjust_prize_stock", { _prize: data.prizeId, _delta: data.delta, _reason: data.reason, _actor: context.userId });
  });

export const adminSaveOperatingCost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ key: z.enum(["vrf_per_spin", "gas_per_spin", "provider_per_spin", "hosting_monthly", "support_monthly"]), amount_usd: usd.nullable(), verified: z.boolean(), evidence: z.string().max(500).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    if (data.verified && (data.amount_usd == null || !data.evidence)) throw new Error("Verified costs need an amount and evidence");
    const db = await h.adminDb();
    const { error } = await db.from("operating_costs").update({ amount_usd: data.amount_usd, verified: data.verified, evidence: data.evidence, updated_by: context.userId, updated_at: new Date().toISOString() }).eq("key", data.key);
    if (error) throw new Error(error.message);
    await h.audit(context.userId, "economics.cost_saved", data);
    return { ok: true };
  });

export const adminRecordFunding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ account: z.enum(["prize_reserve", "sponsored_burn", "sponsored_grant", "sponsored_free_entry"]), amount_usd: z.string().regex(/^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/), evidence: z.string().min(3).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { error } = await db.from("funding_events").insert({ ...data, created_by: context.userId });
    if (error) throw new Error(error.message);
    await h.audit(context.userId, "economics.funding_recorded", data);
    return { ok: true };
  });

export const adminSaveBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ source: z.enum(["burn", "grant", "free_entry"]), paused: z.boolean(), low_water_usd: usd, reason: z.string().max(200).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { error } = await db.from("sponsored_budgets").update({ paused: data.paused, low_water_usd: data.low_water_usd, pause_reason: data.paused ? data.reason ?? "Paused by admin" : null, updated_at: new Date().toISOString() }).eq("source", data.source);
    if (error) throw new Error(error.message);
    if (!data.paused) await h.rpc("resolve_alert", { _kind: "budget_exhausted", _subject: data.source, _actor: context.userId });
    await h.audit(context.userId, "economics.budget_saved", data);
    return { ok: true };
  });

export const adminSetFulfillment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ spinId: z.string().uuid(), status: z.enum(["pending", "shipped", "delivered", "cancelled"]), notes: z.string().max(500).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const db = await h.adminDb();
    const { error } = await db.from("prize_fulfillments").update({ status: data.status, notes: data.notes, updated_at: new Date().toISOString() }).eq("spin_id", data.spinId);
    if (error) throw new Error(error.message);
    await h.audit(context.userId, "prize.fulfillment", data);
    return { ok: true };
  });

/** Sponsored grant of spins (funded from the grant budget) and/or an audited points adjustment. */
export const adminGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ email: z.string().email(), spins: z.number().int().min(0).max(100), points: z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/), note: z.string().min(3).max(200), seasonId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await admin(context.userId);
    const userId = await h.rpc<string | null>("user_id_by_email", { _email: data.email });
    if (!userId) throw new Error("No user with that email");
    let credits: string[] = [];
    if (data.spins > 0) {
      credits = await h.rpc<string[]>("issue_sponsored_credits", { _user: userId, _source: "grant", _count: data.spins, _ref: null, _actor: context.userId, _metadata: { note: data.note } });
      if (!credits.length) throw new Error("The sponsored grant budget is exhausted; grants are paused");
    }
    if (data.points !== "0") {
      if (!data.seasonId) throw new Error("Pick the season for the points adjustment");
      await h.rpc("admin_adjust_points", { _season: data.seasonId, _user: userId, _amount: data.points, _reason: data.note, _actor: context.userId });
    }
    await h.audit(context.userId, "admin.grant", { ...data, user_id: userId, credits: credits.length });
    return { ok: true, credits: credits.length };
  });
