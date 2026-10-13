// Gift certificates (drizzle 0019). A certificate is a prize with a dollar value issued by a vendor. Winners of a
// real draw choose: redeem in person (one-time code the vendor enters in the app) or claim the value (an admin
// forwards the request; the vendor pays the dollar value in APE, at the APE price when they pay, from the
// certificate's issuer wallet to the winner's default wallet; the payment is checked on ApeChain).
// Vendors are promoted by the super admin. Every read and write goes through these server functions.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
async function vendorOf(userId: string): Promise<Vendor | null> {
  const { data } = await (await admin()).from("vendors").select("*").eq("user_id", userId).maybeSingle();
  return (data as Vendor | null) ?? null;
}
async function assertVendor(userId: string) {
  const v = await vendorOf(userId);
  if (!v) throw new Error("Only vendors can do this.");
  return v;
}

export type Vendor = { user_id: string; business_name: string; location: string | null; wallet: string | null };
export type CertStatus = "unclaimed" | "code_issued" | "redeemed" | "requested" | "forwarded" | "paid" | "cancelled";
type CertRow = {
  id: string;
  spin_id: string;
  user_id: string;
  prize_id: string | null;
  prize_name: string;
  vendor_id: string | null;
  issuer_wallet: string | null;
  value_usd: string | number;
  status: CertStatus;
  redeem_code: string | null;
  payout_wallet: string | null;
  ape_wei: string | null;
  ape_usd_rate: string | null;
  quoted_at: string | null;
  pay_tx: string | null;
  pending_tx?: string | null;
  requested_at: string | null;
  forwarded_at: string | null;
  paid_at: string | null;
  redeemed_at: string | null;
  created_at: string;
};

const usd = (v: string | number) => Number(v).toFixed(2);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());

async function apeConfig() {
  const { data } = await (await admin()).from("app_config").select("value").eq("key", "purchase").maybeSingle();
  const cfg = (data?.value ?? {}) as { chain_id?: number; rpc_url?: string; explorer_url?: string; min_confirmations?: number };
  return { chain_id: cfg.chain_id ?? 33139, rpc_url: cfg.rpc_url ?? "https://rpc.apechain.com/http", explorer_url: cfg.explorer_url ?? "https://apescan.io", min_confirmations: cfg.min_confirmations ?? 1 };
}

/**
 * Makes sure every certificate won in a real draw has its record (value, vendor and issuer wallet are copied from
 * the prize at that moment). Optional `userId` limits it to one player.
 */
async function ensureCertificates(userId?: string) {
  const db = await admin();
  const { data: prizes, error } = await db.from("prizes").select("id, name, cert_value_usd, cert_vendor_id, cert_issuer_wallet").not("cert_value_usd", "is", null);
  if (error || !prizes?.length) return; // database update not applied yet, or no certificates
  const byId = new Map((prizes as any[]).map((p) => [p.id as string, p]));
  let q = db.from("spins").select("id, user_id, prize_id, prize_name").eq("status", "fulfilled").in("prize_id", [...byId.keys()]).limit(1000);
  if (userId) q = q.eq("user_id", userId);
  const { data: spins } = await q;
  if (!spins?.length) return;
  const { data: have } = await db.from("gift_certificates").select("spin_id").in("spin_id", (spins as any[]).map((s) => s.id));
  const done = new Set(((have ?? []) as { spin_id: string }[]).map((h) => h.spin_id));
  const rows = (spins as any[])
    .filter((s) => !done.has(s.id))
    .map((s) => {
      const p = byId.get(s.prize_id)!;
      return {
        spin_id: s.id,
        user_id: s.user_id,
        prize_id: s.prize_id,
        prize_name: s.prize_name ?? p.name,
        vendor_id: p.cert_vendor_id,
        issuer_wallet: p.cert_issuer_wallet,
        value_usd: p.cert_value_usd,
      };
    });
  if (rows.length) await db.from("gift_certificates").upsert(rows, { onConflict: "spin_id", ignoreDuplicates: true });
}

async function vendorsById(ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map<string, Vendor>();
  const { data } = await (await admin()).from("vendors").select("*").in("user_id", list);
  return new Map(((data ?? []) as Vendor[]).map((v) => [v.user_id, v]));
}

async function usernames(ids: string[]) {
  const list = [...new Set(ids)];
  if (!list.length) return new Map<string, string>();
  const { data } = await (await admin()).from("profiles").select("id, display_name").in("id", list);
  return new Map(((data ?? []) as { id: string; display_name: string | null }[]).map((p) => [p.id, p.display_name ?? "Player"]));
}

/** A one-time code a person can read out: 8 characters, no look-alikes (0/O, 1/I/L). */
function newCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

// ---------- Players ----------

/** The signed-in player's gift certificates (newest first). */
export const getMyCertificates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureCertificates(context.userId);
    const db = await admin();
    const { data, error } = await db.from("gift_certificates").select("*").eq("user_id", context.userId).order("created_at", { ascending: false });
    if (error) return [];
    const rows = (data ?? []) as CertRow[];
    const vendors = await vendorsById(rows.map((r) => r.vendor_id));
    const cfg = await apeConfig();
    return rows.map((r) => {
      const v = r.vendor_id ? vendors.get(r.vendor_id) : undefined;
      return {
        id: r.id,
        spinId: r.spin_id,
        prize: r.prize_name,
        valueUsd: usd(r.value_usd),
        vendor: v?.business_name ?? "the issuer",
        location: v?.location ?? null,
        status: r.status,
        code: r.status === "code_issued" ? r.redeem_code : null,
        payoutWallet: r.payout_wallet,
        apeWei: r.status === "paid" ? r.ape_wei : null,
        payTx: r.pay_tx ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${r.pay_tx}` : null,
        wonAt: r.created_at,
      };
    });
  });

/**
 * The winner's choice. "in_person": a one-time code to show the vendor. "value": a request for the dollar value in
 * APE, paid to the player's default wallet once an admin forwards it and the vendor pays. The choice can be
 * changed until the certificate is used, forwarded or paid.
 */
export const chooseCertificate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), choice: z.enum(["in_person", "value"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: row } = await db.from("gift_certificates").select("*").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    const c = row as CertRow | null;
    if (!c) throw new Error("That gift certificate isn't on your account.");
    if (!["unclaimed", "code_issued", "requested"].includes(c.status))
      throw new Error("This gift certificate has already been used or is being paid, so it can't be changed.");
    const now = new Date().toISOString();
    if (data.choice === "in_person") {
      const code = c.redeem_code ?? newCode();
      await db.from("gift_certificates").update({ status: "code_issued", redeem_code: code, requested_at: null, payout_wallet: null, updated_at: now }).eq("id", c.id);
      await audit(context.userId, "certificate.in_person", { id: c.id });
      return { status: "code_issued" as const, code };
    }
    const { data: w } = await db.from("wallets").select("address").eq("user_id", context.userId).eq("is_default", true).maybeSingle();
    if (!w?.address) throw new Error("Add a wallet first (My Machine → Wallets): the APE is sent to your default wallet.");
    await db.from("gift_certificates").update({ status: "requested", payout_wallet: String(w.address).toLowerCase(), requested_at: now, redeem_code: null, updated_at: now }).eq("id", c.id);
    await audit(context.userId, "certificate.value_requested", { id: c.id, value_usd: usd(c.value_usd) });
    return { status: "requested" as const, code: null };
  });

// ---------- Admins ----------

/** All certificates won, with player, vendor and status (Admin → Gift certificates). */
export const adminListCertificates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    await ensureCertificates();
    const db = await admin();
    const { data, error } = await db.from("gift_certificates").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) return { ready: false, rows: [] };
    const rows = (data ?? []) as CertRow[];
    const vendors = await vendorsById(rows.map((r) => r.vendor_id));
    const names = await usernames(rows.map((r) => r.user_id));
    const cfg = await apeConfig();
    return {
      ready: true,
      rows: rows.map((r) => ({
        id: r.id,
        prize: r.prize_name,
        valueUsd: usd(r.value_usd),
        player: names.get(r.user_id) ?? "Player",
        vendor: r.vendor_id ? (vendors.get(r.vendor_id)?.business_name ?? "Vendor removed") : "No vendor set",
        hasVendor: !!(r.vendor_id && vendors.get(r.vendor_id)),
        status: r.status,
        payoutWallet: r.payout_wallet,
        issuerWallet: r.issuer_wallet,
        requestedAt: r.requested_at,
        forwardedAt: r.forwarded_at,
        paidAt: r.paid_at,
        redeemedAt: r.redeemed_at,
        payTx: r.pay_tx ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${r.pay_tx}` : null,
        wonAt: r.created_at,
      })),
    };
  });

/** Sends a value request to the certificate's vendor (they see it, with a badge, on their account page). */
export const adminForwardCertificate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: row } = await db.from("gift_certificates").select("*").eq("id", data.id).maybeSingle();
    const c = row as CertRow | null;
    if (!c) throw new Error("Certificate not found.");
    if (c.status !== "requested") throw new Error("Only value requests waiting to be forwarded can be forwarded.");
    if (!c.vendor_id || !(await vendorOf(c.vendor_id))) throw new Error("This certificate has no vendor. Set its vendor in Gift certificates first.");
    const now = new Date().toISOString();
    await db.from("gift_certificates").update({ status: "forwarded", forwarded_at: now, forwarded_by: context.userId, updated_at: now }).eq("id", c.id).eq("status", "requested");
    await audit(context.userId, "certificate.forwarded", { id: c.id, vendor_id: c.vendor_id, value_usd: usd(c.value_usd) });
    return { ok: true };
  });

/** Prizes and their certificate settings, plus the vendors to pick from. */
export const adminCertificatePrizes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: prizes, error } = await db.from("prizes").select("id, name, rarity, active, cert_value_usd, cert_vendor_id, cert_issuer_wallet").order("created_at");
    const { data: vendors } = await db.from("vendors").select("user_id, business_name, wallet").order("business_name");
    return {
      ready: !error,
      prizes: ((prizes ?? []) as any[]).map((p) => ({
        id: p.id as string,
        name: p.name as string,
        rarity: p.rarity as string,
        active: !!p.active,
        valueUsd: p.cert_value_usd == null ? null : usd(p.cert_value_usd),
        vendorId: (p.cert_vendor_id as string | null) ?? null,
        issuerWallet: (p.cert_issuer_wallet as string | null) ?? null,
      })),
      vendors: ((vendors ?? []) as { user_id: string; business_name: string; wallet: string | null }[]).map((v) => ({ id: v.user_id, name: v.business_name, wallet: v.wallet })),
    };
  });

/** Make a prize a gift certificate (value, vendor, issuer wallet), or a normal prize again (value null). */
export const adminSetCertificatePrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        prizeId: z.string().uuid(),
        valueUsd: z.number().positive().max(100_000).nullable(),
        vendorId: z.string().uuid().nullable(),
        issuerWallet: addr.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    if (data.valueUsd != null) {
      if (!data.vendorId || !(await vendorOf(data.vendorId))) throw new Error("Pick the vendor who issues this certificate.");
      if (!data.issuerWallet) throw new Error("Enter the issuer's wallet (the wallet that pays out the certificate's value).");
    }
    const patch =
      data.valueUsd == null
        ? { cert_value_usd: null, cert_vendor_id: null, cert_issuer_wallet: null }
        : { cert_value_usd: data.valueUsd.toFixed(2), cert_vendor_id: data.vendorId, cert_issuer_wallet: data.issuerWallet };
    const { error } = await db.from("prizes").update(patch).eq("id", data.prizeId);
    if (error) throw new Error(/cert_/.test(error.message) ? "Gift certificates turn on after the database update (0019)." : error.message);
    await audit(context.userId, "certificate.prize_set", { prize_id: data.prizeId, ...patch });
    return { ok: true };
  });

// ---------- Super admin: vendors ----------

export const superListVendors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context);
    const db = await admin();
    const { data, error } = await db.from("vendors").select("*").order("business_name");
    if (error) return { ready: false, rows: [] };
    const rows = (data ?? []) as (Vendor & { created_at: string })[];
    const names = await usernames(rows.map((r) => r.user_id));
    return { ready: true, rows: rows.map((r) => ({ ...r, username: names.get(r.user_id) ?? "Player" })) };
  });

/** Promote a player to vendor, or update their business details. */
export const superSetVendor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        userId: z.string().uuid(),
        businessName: z.string().trim().min(2, "Enter the business name").max(120),
        location: z.string().trim().max(300).nullable(),
        wallet: addr.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { error } = await db.from("vendors").upsert(
      { user_id: data.userId, business_name: data.businessName, location: data.location || null, wallet: data.wallet, created_by: context.userId, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(/vendors/.test(error.message) ? "Vendors turn on after the database update (0019)." : error.message);
    await audit(context.userId, "vendor.set", { user_id: data.userId, business_name: data.businessName });
    return { ok: true };
  });

export const superRemoveVendor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    await db.from("vendors").delete().eq("user_id", data.userId);
    await audit(context.userId, "vendor.removed", { user_id: data.userId });
    return { ok: true };
  });

// ---------- Vendors ----------

/** The signed-in player's vendor profile and how many requests wait for them (null = not a vendor). */
export const getMyVendor = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const v = await vendorOf(context.userId).catch(() => null);
    if (!v) return null;
    const { count } = await (await admin()).from("gift_certificates").select("id", { count: "exact", head: true }).eq("vendor_id", context.userId).eq("status", "forwarded");
    return { businessName: v.business_name, location: v.location, wallet: v.wallet, waiting: count ?? 0 };
  });

/** The vendor's certificates: value requests to pay, and recent payments and in-person redemptions. */
export const vendorListCertificates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertVendor(context.userId);
    const db = await admin();
    const { data } = await db.from("gift_certificates").select("*").eq("vendor_id", context.userId).in("status", ["forwarded", "paid", "redeemed"]).order("updated_at", { ascending: false }).limit(200);
    const rows = (data ?? []) as CertRow[];
    const names = await usernames(rows.map((r) => r.user_id));
    const cfg = await apeConfig();
    return rows.map((r) => ({
      id: r.id,
      prize: r.prize_name,
      valueUsd: usd(r.value_usd),
      player: names.get(r.user_id) ?? "Player",
      status: r.status,
      payoutWallet: r.payout_wallet,
      issuerWallet: r.issuer_wallet,
      forwardedAt: r.forwarded_at,
      paidAt: r.paid_at,
      redeemedAt: r.redeemed_at,
      apeWei: r.ape_wei,
      pendingTx: r.status === "forwarded" ? (r.pending_tx ?? null) : null,
      payTx: r.pay_tx ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${r.pay_tx}` : null,
    }));
  });

/** In person: the vendor types the winner's one-time code; the certificate is used up. */
export const vendorRedeemCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ code: z.string().trim().min(4).max(20) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertVendor(context.userId);
    const db = await admin();
    const code = data.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const { data: row } = await db.from("gift_certificates").select("*").eq("vendor_id", context.userId).eq("status", "code_issued").eq("redeem_code", code).maybeSingle();
    const c = row as CertRow | null;
    if (!c) throw new Error("That code doesn't match an unused gift certificate from your business.");
    const now = new Date().toISOString();
    const { data: done } = await db
      .from("gift_certificates")
      .update({ status: "redeemed", redeemed_at: now, redeem_code: null, updated_at: now })
      .eq("id", c.id)
      .eq("status", "code_issued")
      .select("id");
    if (!done?.length) throw new Error("That certificate was just used.");
    await audit(context.userId, "certificate.redeemed", { id: c.id, value_usd: usd(c.value_usd) });
    const names = await usernames([c.user_id]);
    return { prize: c.prize_name, valueUsd: usd(c.value_usd), player: names.get(c.user_id) ?? "Player" };
  });

/**
 * Value request: the APE amount for the certificate's dollar value at the APE price right now, and where to send it.
 * The vendor's Glyph wallet then sends it (must be the certificate's issuer wallet).
 */
export const vendorQuotePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertVendor(context.userId);
    const db = await admin();
    const { data: row } = await db.from("gift_certificates").select("*").eq("id", data.id).eq("vendor_id", context.userId).maybeSingle();
    const c = row as CertRow | null;
    if (!c) throw new Error("Request not found.");
    if (c.status !== "forwarded") throw new Error(c.status === "paid" ? "This request is already paid." : "This request isn't waiting for payment.");
    if (!c.payout_wallet) throw new Error("The winner's wallet is missing.");
    if (c.pending_tx) throw new Error("A payment for this request is already on its way. Tap “Check payment” instead of paying again.");
    const { quoteUsdInApe } = await import("./purchase.server");
    const q = await quoteUsdInApe(usd(c.value_usd));
    await db.from("gift_certificates").update({ ape_wei: q.wei.toString(), ape_usd_rate: q.rate, quoted_at: q.quotedAt, updated_at: q.quotedAt }).eq("id", c.id);
    const cfg = await apeConfig();
    return { to: c.payout_wallet, valueWei: q.wei.toString(), chainId: cfg.chain_id, issuerWallet: c.issuer_wallet, rate: q.rate, valueUsd: usd(c.value_usd) };
  });

/** After the vendor's wallet sent the APE: check it on ApeChain and mark the request paid. */
export const vendorConfirmPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertVendor(context.userId);
    const db = await admin();
    const { data: row } = await db.from("gift_certificates").select("*").eq("id", data.id).eq("vendor_id", context.userId).maybeSingle();
    const c = row as CertRow | null;
    if (!c) throw new Error("Request not found.");
    if (c.status === "paid") return { state: "ok" as const };
    if (c.status !== "forwarded" || !c.ape_wei || !c.payout_wallet) throw new Error("This request isn't waiting for payment.");
    const { checkApeTransfer } = await import("./purchase.server");
    const cfg = await apeConfig();
    const r = await checkApeTransfer(cfg, data.txHash as `0x${string}`, { from: c.issuer_wallet, to: c.payout_wallet, minWei: BigInt(c.ape_wei) });
    if (r.state === "pending") {
      // Sent but not confirmed yet: remember it, so the vendor checks this payment instead of paying twice.
      if (!c.pending_tx) await db.from("gift_certificates").update({ pending_tx: data.txHash.toLowerCase(), updated_at: new Date().toISOString() }).eq("id", c.id);
      return r;
    }
    if (r.state === "invalid") {
      // Not a valid payment: forget it so the vendor can pay properly.
      if (c.pending_tx === data.txHash.toLowerCase()) await db.from("gift_certificates").update({ pending_tx: null }).eq("id", c.id);
      return r;
    }
    const now = new Date().toISOString();
    const { error } = await db.from("gift_certificates").update({ status: "paid", pay_tx: data.txHash.toLowerCase(), pending_tx: null, paid_at: now, updated_at: now }).eq("id", c.id).eq("status", "forwarded");
    if (error) throw new Error(/pay_tx/.test(error.message) ? "That transaction was already used for another certificate." : error.message);
    await audit(context.userId, "certificate.paid", { id: c.id, tx: data.txHash, ape_wei: c.ape_wei, value_usd: usd(c.value_usd) });
    return { state: "ok" as const };
  });
