// IRL (physical) prize claims. A real Chainlink spin that lands on a prize marked "IRL" (prizes.is_physical)
// gives the player a claim: they tell the team how to receive it (pick up at ApeFest or ship it), and admins
// move it through approved → shipped → delivered. Claim rows live in prize_claims (drizzle 0006).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden");
}

export type ClaimStatus = "submitted" | "approved" | "shipped" | "delivered" | "rejected";
export type IrlWin = {
  spin_id: string;
  won_at: string;
  prize_id: string | null;
  prize_name: string;
  rarity: string | null;
  image_path: string | null;
  claim: null | {
    id: string;
    status: ClaimStatus;
    delivery: "pickup" | "ship";
    full_name: string;
    email: string;
    phone: string | null;
    address: Record<string, string> | null;
    notes: string | null;
    admin_note: string | null;
    tracking: string | null;
    updated_at: string;
    /** Shipping the winner chose and pays (ship only). */
    ship_carrier: string | null;
    ship_service: string | null;
    ship_days: number | null;
    ship_usd: string | null;
    ship_paid_at: string | null;
    ship_pending_tx: string | null;
  };
};

/** The signed-in player's IRL prize wins (real draws only) and where each claim stands. */
export const getMyIrlPrizes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<IrlWin[]> => {
    const db = await admin();
    const { data: physical, error: pe } = await db.from("prizes").select("id, image_url").eq("is_physical", true);
    if (pe) return []; // prizes.is_physical not there yet (database update pending)
    const prizeIds = ((physical ?? []) as { id: string; image_url: string | null }[]).map((p) => p.id);
    if (!prizeIds.length) return [];
    const images = new Map(((physical ?? []) as { id: string; image_url: string | null }[]).map((p) => [p.id, p.image_url]));
    const { data: spins, error } = await db
      .from("spins")
      .select("id, prize_id, prize_name, rarity, created_at, fulfilled_at")
      .eq("user_id", context.userId)
      .eq("status", "fulfilled")
      .in("prize_id", prizeIds)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (spins ?? []) as { id: string; prize_id: string; prize_name: string; rarity: string | null; created_at: string; fulfilled_at: string | null }[];
    if (!rows.length) return [];
    const { data: claims, error: ce } = await db.from("prize_claims").select("*").in("spin_id", rows.map((r) => r.id));
    if (ce && !/prize_claims/.test(ce.message)) throw new Error(ce.message);
    const bySpin = new Map(((claims ?? []) as (IrlWin["claim"] & { spin_id: string })[]).map((c) => [c!.spin_id, c]));
    return rows.map((r) => {
      const c = bySpin.get(r.id);
      return {
        spin_id: r.id,
        won_at: r.fulfilled_at ?? r.created_at,
        prize_id: r.prize_id,
        prize_name: r.prize_name,
        rarity: r.rarity,
        image_path: images.get(r.prize_id) ?? null,
        claim: c
          ? {
              id: c.id, status: c.status, delivery: c.delivery, full_name: c.full_name, email: c.email, phone: c.phone, address: c.address, notes: c.notes, admin_note: c.admin_note, tracking: c.tracking, updated_at: c.updated_at,
              ship_carrier: c.ship_carrier ?? null, ship_service: c.ship_service ?? null, ship_days: c.ship_days ?? null,
              ship_usd: c.ship_usd == null ? null : Number(c.ship_usd).toFixed(2), ship_paid_at: c.ship_paid_at ?? null, ship_pending_tx: c.ship_pending_tx ?? null,
            }
          : null,
      };
    });
  });

export const addressSchema = z.object({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().max(100).optional().default(""),
  postal: z.string().trim().min(2).max(20),
  country: z.string().trim().min(2).max(60),
});

export const claimSchema = z
  .object({
    spinId: z.string().uuid(),
    fullName: z.string().trim().min(2, "Enter your full name").max(120),
    email: z.string().trim().email("Enter a valid email").max(255),
    phone: z.string().trim().max(40).optional().default(""),
    delivery: z.enum(["pickup", "ship"]),
    address: addressSchema.optional(),
    notes: z.string().trim().max(1000).optional().default(""),
    /** The shipping rate the winner picked (from `getShippingRates`); needed to ship unless already paid. */
    shipQuoteId: z.string().uuid().optional(),
    shipRateId: z.string().max(100).optional(),
  })
  .refine((d) => d.delivery === "pickup" || !!d.address, { message: "Enter the shipping address", path: ["address"] });

/** Submit (or, while it's still waiting for review, update) the claim for one IRL prize win. */
export const submitPrizeClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => claimSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: spin } = await db
      .from("spins")
      .select("id, user_id, status, prize_id, prize_name")
      .eq("id", data.spinId)
      .maybeSingle();
    if (!spin || spin.user_id !== context.userId || spin.status !== "fulfilled") throw new Error("That prize isn't yours to claim");
    const { data: prize } = await db.from("prizes").select("is_physical").eq("id", spin.prize_id).maybeSingle();
    if (!prize?.is_physical) throw new Error("That prize doesn't need a claim");
    const { data: existing } = await db.from("prize_claims").select("*").eq("spin_id", data.spinId).maybeSingle();
    if (existing && existing.status !== "submitted") throw new Error("This claim is already being handled. Use the guide's Contact form for changes.");
    // Shipping: the winner pays it. Once paid (or on its way), delivery and address stay as they are.
    let shipping: Record<string, unknown> = {};
    const paid = !!(existing?.ship_paid_at || existing?.ship_pending_tx);
    if (paid) {
      const { sameAddress } = await import("./shipping.functions");
      if (data.delivery !== "ship" || !sameAddress(existing.address, data.address))
        throw new Error("Shipping to this address is already paid, so the delivery and address can't change here. Use the guide's Contact form.");
    } else if (data.delivery === "ship") {
      if (!data.shipQuoteId || !data.shipRateId) throw new Error("Calculate the shipping and pick a rate first.");
      const { pickedRate } = await import("./shipping.functions");
      shipping = await pickedRate(context.userId, data.spinId, data.address!, data.shipQuoteId, data.shipRateId);
    } else if (existing?.ship_usd != null) {
      shipping = { ship_quote_id: null, ship_rate_id: null, ship_carrier: null, ship_service: null, ship_days: null, ship_usd: null, ship_ape_wei: null, ship_ape_rate: null, ship_quoted_at: null };
    }
    const row = {
      spin_id: data.spinId,
      user_id: context.userId,
      prize_id: spin.prize_id,
      prize_name: spin.prize_name,
      full_name: data.fullName,
      email: data.email.toLowerCase(),
      phone: data.phone || null,
      delivery: data.delivery,
      address: data.delivery === "ship" ? data.address : null,
      notes: data.notes || null,
      ...shipping,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = existing
      ? await db.from("prize_claims").update(row).eq("id", existing.id).select("id").single()
      : await db.from("prize_claims").insert(row).select("id").single();
    if (error) throw new Error(`Couldn't save your claim: ${error.message}`);
    await db.from("audit_log").insert({ actor: context.userId, action: existing ? "prize_claim.updated" : "prize_claim.submitted", details: { claim_id: saved.id, spin_id: data.spinId, prize: spin.prize_name, delivery: data.delivery } });

    const { data: u } = await db.auth.admin.getUserById(context.userId);
    const a = data.delivery === "ship" ? data.address! : null;
    const { emailTeam } = await import("./team-email.server");
    await emailTeam(db, {
      template: "prize-claim-notification",
      data: {
        prize: spin.prize_name,
        player: u?.user?.email ?? context.userId,
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        delivery:
          data.delivery === "pickup"
            ? "Pick up at ApeFest Charleston"
            : paid
              ? `Ship it — shipping already paid (${existing.ship_carrier ?? ""} ${existing.ship_service ?? ""}, $${Number(existing.ship_usd).toFixed(2)})`
              : `Ship it — ${shipping["ship_carrier"]} ${shipping["ship_service"]}, $${shipping["ship_usd"]} paid by the winner in APE (payment pending; see Admin → IRL claims)`,
        address: a ? [a.line1, a.line2, `${a.city}${a.region ? `, ${a.region}` : ""} ${a.postal}`, a.country].filter(Boolean).join("\n") : "",
        notes: data.notes,
      },
      key: `claim:${saved.id}:${existing ? "update" : "new"}:${row.updated_at}`,
      replyTo: data.email,
      auditPrefix: "prize_claim",
      details: { claim_id: saved.id },
    });
    const ship = data.delivery === "ship" ? (paid ? existing : shipping) : null;
    return {
      claimId: saved.id as string,
      updated: !!existing,
      shipping: ship ? { usd: Number(ship["ship_usd"]).toFixed(2), carrier: String(ship["ship_carrier"] ?? ""), service: String(ship["ship_service"] ?? ""), paid } : null,
    };
  });

/** Admin: every IRL prize won in a real draw, with its claim (or "not claimed yet"). */
export const adminListIrlClaims = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: physical, error: pe } = await db.from("prizes").select("id").eq("is_physical", true);
    if (pe) return { rows: [], ready: false };
    const ids = ((physical ?? []) as { id: string }[]).map((p) => p.id);
    if (!ids.length) return { rows: [], ready: true };
    const { data: spins, error } = await db
      .from("spins")
      .select("id, user_id, prize_name, rarity, created_at, fulfilled_at, request_tx")
      .eq("status", "fulfilled")
      .in("prize_id", ids)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const list = (spins ?? []) as { id: string; user_id: string; prize_name: string; rarity: string | null; created_at: string; fulfilled_at: string | null }[];
    const { data: claims, error: ce } = list.length ? await db.from("prize_claims").select("*").in("spin_id", list.map((s) => s.id)) : { data: [], error: null };
    const ready = !ce;
    const bySpin = new Map(((claims ?? []) as any[]).map((c) => [c.spin_id, c]));
    const userIds = [...new Set(list.map((s) => s.user_id))];
    const emails = new Map<string, string>();
    await Promise.all(
      userIds.map(async (id) => {
        const { data: u } = await db.auth.admin.getUserById(id);
        emails.set(id, u?.user?.email ?? id);
      }),
    );
    const names = new Map<string, string>();
    if (userIds.length) {
      const { data: profs } = await db.from("profiles").select("id, display_name").in("id", userIds);
      for (const p of (profs ?? []) as { id: string; display_name: string | null }[]) if (p.display_name) names.set(p.id, p.display_name);
    }
    const { data: pcfg } = await db.from("app_config").select("value").eq("key", "purchase").maybeSingle();
    const explorer = String((pcfg?.value as { explorer_url?: string } | null)?.explorer_url ?? "https://apescan.io").replace(/\/$/, "");
    return {
      ready,
      rows: list.map((s) => ({
        shipTxUrl: bySpin.get(s.id)?.ship_pay_tx ? `${explorer}/tx/${bySpin.get(s.id).ship_pay_tx}` : null,
        spin_id: s.id,
        won_at: s.fulfilled_at ?? s.created_at,
        player: emails.get(s.user_id) ?? s.user_id,
        /** The player's username (falls back to their email). */
        username: names.get(s.user_id) ?? null,
        prize: s.prize_name,
        rarity: s.rarity,
        claim: (bySpin.get(s.id) ?? null) as null | {
          id: string; status: ClaimStatus; full_name: string; email: string; phone: string | null; delivery: "pickup" | "ship";
          address: Record<string, string> | null; notes: string | null; admin_note: string | null; tracking: string | null; created_at: string; updated_at: string;
          ship_carrier?: string | null; ship_service?: string | null; ship_days?: number | null; ship_usd?: string | number | null; ship_paid_at?: string | null; ship_pending_tx?: string | null;
        },
      })),
    };
  });

/** Admin: move a claim along (approved → shipped → delivered, or rejected) with an optional note/tracking. */
export const adminUpdateClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        claimId: z.string().uuid(),
        status: z.enum(["submitted", "approved", "shipped", "delivered", "rejected"]),
        adminNote: z.string().trim().max(1000).optional(),
        tracking: z.string().trim().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: c, error } = await db
      .from("prize_claims")
      .update({
        status: data.status,
        ...(data.adminNote !== undefined ? { admin_note: data.adminNote || null } : {}),
        ...(data.tracking !== undefined ? { tracking: data.tracking || null } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.claimId)
      .select("spin_id")
      .single();
    if (error) throw new Error(error.message);
    // Keep the winners list's "delivered" mark in step with the claim.
    if (data.status === "delivered") await db.from("spins").update({ delivered_at: new Date().toISOString(), delivered_by: context.userId }).eq("id", c.spin_id);
    await db.from("audit_log").insert({ actor: context.userId, action: "prize_claim.status", details: { claim_id: data.claimId, status: data.status } });
    return { ok: true };
  });
