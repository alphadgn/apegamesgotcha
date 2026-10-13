// Shipping for IRL prizes (drizzle 0021). A winner who has their prize mailed pays the shipping:
//   1. the claim form asks for live carrier rates to their address (`getShippingRates`, Shippo) for the prize's box;
//   2. they pick a rate and send the claim (`submitPrizeClaim` only accepts a rate this server quoted for that
//      exact address);
//   3. they pay the rate's dollar amount in APE at the live price from their Glyph wallet to the treasury
//      (`quoteShippingPayment` → wallet → `confirmShippingPayment`, checked on ApeChain).
// Ship-from address, handling fee and default box: app_config.shipping (Admin → IRL claims → Shipping setup).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { addressSchema } from "./claims.functions";
import { countryCode } from "./countries";
import type { Parcel, ShipAddress, ShipRate } from "./shipping.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
async function audit(actor: string, action: string, details: unknown) {
  await (await admin()).from("audit_log").insert({ actor, action, details: details as any });
}
async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden");
}
async function assertSuper(ctx: { supabase: any; userId: string }) {
  await assertAdmin(ctx);
  const { superAdminId } = await import("./roles.server");
  if ((await superAdminId(await admin())) !== ctx.userId) throw new Error("Only the super admin can do this.");
}

export type ShippingConfig = {
  from: Partial<ShipAddress>;
  /** Added to every carrier rate (packing materials, handling), in dollars. */
  handling_usd: string;
  /** Box used for IRL prizes without their own size. */
  default_box: Parcel;
};
const DEFAULT_BOX: Parcel = { weight_oz: 16, length_in: 10, width_in: 8, height_in: 4 };
/** How long a quoted rate can be used for a claim. */
const QUOTE_LIFE_MS = 2 * 60 * 60_000;

async function shippingConfig(): Promise<ShippingConfig> {
  const { data } = await (await admin()).from("app_config").select("value").eq("key", "shipping").maybeSingle();
  const v = (data?.value ?? {}) as Partial<ShippingConfig>;
  return {
    from: v.from ?? {},
    handling_usd: /^\d+(\.\d{1,2})?$/.test(String(v.handling_usd ?? "")) ? String(v.handling_usd) : "0",
    default_box: { ...DEFAULT_BOX, ...(v.default_box ?? {}) },
  };
}
function fromMissing(f: Partial<ShipAddress>) {
  const need: [keyof ShipAddress, string][] = [["name", "name"], ["street1", "street"], ["city", "city"], ["zip", "ZIP"], ["country", "country"], ["phone", "phone"], ["email", "email"]];
  return need.filter(([k]) => !String(f[k] ?? "").trim()).map(([, l]) => l);
}

async function purchaseCfg() {
  const { data } = await (await admin()).from("app_config").select("value").eq("key", "purchase").maybeSingle();
  const c = (data?.value ?? {}) as { chain_id?: number; rpc_url?: string; explorer_url?: string; min_confirmations?: number; treasury?: string };
  return {
    chain_id: c.chain_id ?? 33139,
    rpc_url: c.rpc_url ?? "https://rpc.apechain.com/http",
    explorer_url: (c.explorer_url ?? "https://apescan.io").replace(/\/$/, ""),
    min_confirmations: c.min_confirmations ?? 1,
    treasury: /^0x[0-9a-fA-F]{40}$/.test(c.treasury ?? "") ? c.treasury!.toLowerCase() : null,
  };
}

type Addr = z.infer<typeof addressSchema>;
/** Same address? (ignores capitals and extra spaces) */
export function sameAddress(a: Partial<Addr> | null | undefined, b: Partial<Addr> | null | undefined) {
  const n = (x: Partial<Addr> | null | undefined) =>
    ["line1", "line2", "city", "region", "postal", "country"].map((k) => String((x as any)?.[k] ?? "").trim().replace(/\s+/g, " ").toLowerCase()).join("|");
  return n(a) === n(b);
}

/** The winner's own IRL win (fulfilled real spin on a physical prize), with the prize's box. */
async function ownIrlWin(userId: string, spinId: string) {
  const db = await admin();
  const { data: spin } = await db.from("spins").select("id, user_id, status, prize_id, prize_name").eq("id", spinId).maybeSingle();
  if (!spin || spin.user_id !== userId || spin.status !== "fulfilled") throw new Error("That prize isn't yours to claim.");
  const { data: prize } = await db.from("prizes").select("*").eq("id", spin.prize_id).maybeSingle();
  if (!prize?.is_physical) throw new Error("That prize doesn't need shipping.");
  return { spin, prize };
}

// ---------- Players ----------

/** Live carrier rates for mailing this IRL prize to the address given (the winner pays the one they pick). */
export const getShippingRates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        spinId: z.string().uuid(),
        fullName: z.string().trim().min(2, "Enter your full name first").max(120),
        email: z.string().trim().email("Enter your email first").max(255),
        phone: z.string().trim().max(40).optional().default(""),
        address: addressSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { prize } = await ownIrlWin(context.userId, data.spinId);
    const db = await admin();
    const { data: claim } = await db.from("prize_claims").select("ship_paid_at, ship_pending_tx").eq("spin_id", data.spinId).maybeSingle();
    if (claim?.ship_paid_at || claim?.ship_pending_tx) throw new Error("Shipping for this prize is already paid.");
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count } = await db.from("shipping_quotes").select("id", { count: "exact", head: true }).eq("user_id", context.userId).gte("created_at", since);
    if ((count ?? 0) >= 20) throw new Error("That's a lot of shipping quotes. Try again in an hour.");
    const to = countryCode(data.address.country);
    if (!to) throw new Error("Pick your country from the list.");
    if (to === "US" && !data.address.region) throw new Error("Enter your state.");
    const cfg = await shippingConfig();
    if (fromMissing(cfg.from).length) throw new Error("Shipping prices aren't switched on yet (the team is finishing the setup). Choose pick-up, or try again later.");
    const box: Parcel = {
      weight_oz: Number(prize.ship_weight_oz ?? cfg.default_box.weight_oz),
      length_in: Number(prize.ship_length_in ?? cfg.default_box.length_in),
      width_in: Number(prize.ship_width_in ?? cfg.default_box.width_in),
      height_in: Number(prize.ship_height_in ?? cfg.default_box.height_in),
    };
    const { shippoRates } = await import("./shipping.server");
    const raw = await shippoRates(
      { ...cfg.from, country: countryCode(cfg.from.country) ?? "US" } as ShipAddress,
      {
        name: data.fullName,
        street1: data.address.line1,
        street2: data.address.line2,
        city: data.address.city,
        state: data.address.region,
        zip: data.address.postal,
        country: to,
        phone: data.phone || String(cfg.from.phone ?? ""),
        email: data.email,
      },
      box,
    );
    const extra = Number(cfg.handling_usd);
    const rates: ShipRate[] = raw.map((r) => ({ ...r, usd: (Number(r.usd) + extra).toFixed(2) }));
    const { data: q, error } = await db
      .from("shipping_quotes")
      .insert({ user_id: context.userId, spin_id: data.spinId, address: data.address, rates })
      .select("id, created_at")
      .single();
    if (error) throw new Error(/shipping_quotes/.test(error.message) ? "Shipping turns on after the database update (0021)." : error.message);
    return { quoteId: q.id as string, rates, handlingUsd: extra ? extra.toFixed(2) : null, validUntil: new Date(new Date(q.created_at).getTime() + QUOTE_LIFE_MS).toISOString() };
  });

/**
 * Checks a rate the winner picked for their claim: quoted by this server, for this player, prize and address,
 * not older than 2 hours. Returns the claim fields to save. Used by `submitPrizeClaim`.
 */
export async function pickedRate(userId: string, spinId: string, address: Addr, quoteId: string, rateId: string) {
  const { data: q } = await (await admin()).from("shipping_quotes").select("*").eq("id", quoteId).maybeSingle();
  if (!q || q.user_id !== userId || q.spin_id !== spinId) throw new Error("Calculate the shipping again, then pick a rate.");
  if (Date.now() - new Date(q.created_at).getTime() > QUOTE_LIFE_MS) throw new Error("That shipping price expired. Calculate the shipping again.");
  if (!sameAddress(q.address, address)) throw new Error("The address changed since the shipping was calculated. Calculate it again.");
  const r = ((q.rates ?? []) as ShipRate[]).find((x) => x.id === rateId);
  if (!r) throw new Error("Pick one of the shipping rates.");
  return {
    ship_quote_id: quoteId,
    ship_rate_id: r.id,
    ship_carrier: r.carrier,
    ship_service: r.service,
    ship_days: r.days,
    ship_usd: r.usd,
    ship_ape_wei: null,
    ship_ape_rate: null,
    ship_quoted_at: null,
  };
}

async function myShipClaim(userId: string, spinId: string) {
  const { data } = await (await admin()).from("prize_claims").select("*").eq("spin_id", spinId).eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("Send your claim first.");
  if (data.delivery !== "ship" || data.ship_usd == null) throw new Error("This claim has no shipping to pay.");
  if (data.status === "rejected") throw new Error("This claim needs attention from the team first.");
  return data as any;
}

/** The APE amount for the chosen shipping at the APE price right now, and where to send it (the treasury). */
export const quoteShippingPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ spinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const c = await myShipClaim(context.userId, data.spinId);
    if (c.ship_paid_at) throw new Error("Shipping is already paid.");
    if (c.ship_pending_tx) throw new Error("Your shipping payment is already on its way. Tap “Check payment” instead of paying again.");
    const cfg = await purchaseCfg();
    if (!cfg.treasury) throw new Error("Payments aren't set up yet. Try again later.");
    const usd = Number(c.ship_usd).toFixed(2);
    const { quoteUsdInApe } = await import("./purchase.server");
    const q = await quoteUsdInApe(usd);
    await (await admin()).from("prize_claims").update({ ship_ape_wei: q.wei.toString(), ship_ape_rate: q.rate, ship_quoted_at: q.quotedAt }).eq("id", c.id);
    return { to: cfg.treasury, valueWei: q.wei.toString(), chainId: cfg.chain_id, usd, rate: q.rate };
  });

/** After the winner's wallet sent the APE: check it on ApeChain and mark the shipping paid. */
export const confirmShippingPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ spinId: z.string().uuid(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const c = await myShipClaim(context.userId, data.spinId);
    if (c.ship_paid_at) return { state: "ok" as const };
    if (!c.ship_ape_wei) throw new Error("Start the payment again.");
    const hash = data.txHash.toLowerCase();
    const db = await admin();
    // A transaction pays for one thing only.
    const { data: asPurchase } = await db.from("spin_purchases").select("id").eq("tx_hash", hash).maybeSingle();
    const { data: asOther } = await db.from("prize_claims").select("id").eq("ship_pay_tx", hash).maybeSingle();
    if (asPurchase || (asOther && asOther.id !== c.id)) return { state: "invalid" as const, reason: "That transaction was already used for another payment." };
    const cfg = await purchaseCfg();
    if (!cfg.treasury) throw new Error("Payments aren't set up yet.");
    const { checkApeTransfer } = await import("./purchase.server");
    const r = await checkApeTransfer(cfg, hash as `0x${string}`, { to: cfg.treasury, minWei: BigInt(c.ship_ape_wei) });
    if (r.state === "pending") {
      if (!c.ship_pending_tx) await db.from("prize_claims").update({ ship_pending_tx: hash }).eq("id", c.id);
      return r;
    }
    if (r.state === "invalid") {
      if (c.ship_pending_tx === hash) await db.from("prize_claims").update({ ship_pending_tx: null }).eq("id", c.id);
      return { state: "invalid" as const, reason: r.reason.replace("the winner's wallet", "the ApeGames treasury") };
    }
    const payer = r.payer.toLowerCase();
    const { data: mine } = await db.from("wallets").select("address").eq("user_id", context.userId).eq("address", payer).maybeSingle();
    if (!mine) {
      if (c.ship_pending_tx === hash) await db.from("prize_claims").update({ ship_pending_tx: null }).eq("id", c.id);
      return { state: "invalid" as const, reason: "That payment came from a wallet that isn't linked to your account." };
    }
    const now = new Date().toISOString();
    const { error } = await db
      .from("prize_claims")
      .update({ ship_pay_tx: hash, ship_payer: payer, ship_paid_at: now, ship_pending_tx: null, updated_at: now })
      .eq("id", c.id)
      .is("ship_paid_at", null);
    if (error) return { state: "invalid" as const, reason: /ship_pay_tx/.test(error.message) ? "That transaction was already used for another payment." : error.message };
    await audit(context.userId, "prize_claim.shipping_paid", { claim_id: c.id, usd: c.ship_usd, ape_wei: c.ship_ape_wei, tx: hash });
    return { state: "ok" as const };
  });

// ---------- Admins ----------

/** Shipping setup: ship-from address, handling fee, default box, and each IRL prize's box. */
export const adminShippingSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const cfg = await shippingConfig();
    const { data: prizes, error } = await db.from("prizes").select("*").eq("is_physical", true).order("created_at");
    const { shippoReady } = await import("./shipping.server");
    const pc = await purchaseCfg();
    return {
      ready: !error && (prizes ?? []).every((p: any) => "ship_weight_oz" in p),
      config: cfg,
      fromMissing: fromMissing(cfg.from),
      shippoKey: shippoReady(),
      treasury: !!pc.treasury,
      prizes: ((prizes ?? []) as any[]).map((p) => ({
        id: p.id as string,
        name: p.name as string,
        active: !!p.active,
        box: {
          weight_oz: p.ship_weight_oz == null ? null : Number(p.ship_weight_oz),
          length_in: p.ship_length_in == null ? null : Number(p.ship_length_in),
          width_in: p.ship_width_in == null ? null : Number(p.ship_width_in),
          height_in: p.ship_height_in == null ? null : Number(p.ship_height_in),
        },
      })),
    };
  });

const boxSchema = z.object({
  weight_oz: z.number().positive().max(2400),
  length_in: z.number().positive().max(120),
  width_in: z.number().positive().max(120),
  height_in: z.number().positive().max(120),
});

/** Ship-from address, handling fee and default box (super admin). */
export const adminSetShippingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        from: z.object({
          name: z.string().trim().min(2).max(120),
          company: z.string().trim().max(120).optional().default(""),
          street1: z.string().trim().min(3).max(200),
          street2: z.string().trim().max(200).optional().default(""),
          city: z.string().trim().min(2).max(100),
          state: z.string().trim().max(100).optional().default(""),
          zip: z.string().trim().min(2).max(20),
          country: z.string().trim().length(2).transform((c) => c.toUpperCase()),
          phone: z.string().trim().min(7).max(40),
          email: z.string().trim().email().max(255),
        }),
        handling_usd: z.string().trim().regex(/^\d{1,4}(\.\d{1,2})?$/, "Handling fee in dollars, e.g. 2.50"),
        default_box: boxSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { error } = await db.from("app_config").upsert({ key: "shipping", value: data, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    await audit(context.userId, "shipping.config", { handling_usd: data.handling_usd, from_city: data.from.city, default_box: data.default_box });
    return { ok: true };
  });

/** One IRL prize's box (null = use the default box). */
export const adminSetPrizeBox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ prizeId: z.string().uuid(), box: boxSchema.nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const b = data.box;
    const { error } = await (await admin())
      .from("prizes")
      .update({ ship_weight_oz: b?.weight_oz ?? null, ship_length_in: b?.length_in ?? null, ship_width_in: b?.width_in ?? null, ship_height_in: b?.height_in ?? null })
      .eq("id", data.prizeId);
    if (error) throw new Error(/ship_/.test(error.message) ? "Shipping turns on after the database update (0021)." : error.message);
    await audit(context.userId, "shipping.prize_box", { prize_id: data.prizeId, box: b });
    return { ok: true };
  });
