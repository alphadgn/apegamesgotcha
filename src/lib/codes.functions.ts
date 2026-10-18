// Free-spin redemption codes (drizzle 0024). Admins make a short hex code that gives spins for a time window
// (default 4 hours); each signed-in player can redeem it once. The checks and the grant happen atomically in the
// database function redeem_spin_code.
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

export const normalizeCode = (c: string) => c.toLowerCase().replace(/[^0-9a-f]/g, "");

/** A player redeems a code. */
export const redeemSpinCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ code: z.string().trim().min(1, "Enter the code").max(40) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await admin();
    // Slow down guessing: at most 10 wrong codes per player per 10 minutes.
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const { count } = await db
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("actor", context.userId)
      .eq("action", "code.failed")
      .gte("created_at", since);
    if ((count ?? 0) >= 10) throw new Error("Too many tries. Wait a few minutes and try again.");
    const { data: r, error } = await db.rpc("redeem_spin_code", {
      _user_id: context.userId,
      _code: data.code,
    });
    if (error) {
      const msg = String(error.message ?? "");
      const known = /isn't valid|isn't active yet|has expired|already redeemed|used up/.test(msg);
      await db.from("audit_log").insert({
        actor: context.userId,
        action: "code.failed",
        details: { code: normalizeCode(data.code).slice(0, 10), reason: msg.slice(0, 120) },
      });
      if (/redeem_spin_code/.test(msg) && !known)
        throw new Error("Codes turn on after the database update (0024).");
      throw new Error(known ? msg : "Couldn't redeem that code. Try again.");
    }
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "code.redeemed",
      details: { code: normalizeCode(data.code), ...(r as object) },
    });
    return r as { spins: number; kind: "real" | "demo"; expires_at: string };
  });

/** Admin: make a code (random 10 hex characters unless one is given). */
export const adminCreateSpinCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        spins: z.number().int().min(1).max(10),
        kind: z.enum(["real", "demo"]),
        hours: z
          .number()
          .min(0.25)
          .max(24 * 30),
        maxRedemptions: z.number().int().min(1).max(100000).nullable(),
        note: z.string().trim().max(200).default(""),
        code: z.string().trim().max(20).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    let code = data.code ? normalizeCode(data.code) : "";
    if (code && !/^[0-9a-f]{8,10}$/.test(code))
      throw new Error("A code is 8 to 10 hex characters (0–9, a–f).");
    if (!code)
      code = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const now = Date.now();
    const row = {
      code,
      kind: data.kind,
      spins: data.spins,
      starts_at: new Date(now).toISOString(),
      expires_at: new Date(now + data.hours * 3_600_000).toISOString(),
      max_redemptions: data.maxRedemptions,
      note: data.note,
      created_by: context.userId,
    };
    const { error } = await db.from("spin_codes").insert(row);
    if (error)
      throw new Error(
        /duplicate|23505/.test(error.message)
          ? "That code already exists."
          : /spin_codes/.test(error.message)
            ? "Codes turn on after the database update (0024)."
            : error.message,
      );
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "code.created",
      details: {
        code,
        kind: data.kind,
        spins: data.spins,
        expires_at: row.expires_at,
        max: data.maxRedemptions,
      },
    });
    return { code, expiresAt: row.expires_at };
  });

export const adminListSpinCodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data, error } = await db
      .from("spin_codes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return { ready: false, rows: [] };
    const ids = ((data ?? []) as { id: string }[]).map((c) => c.id);
    const { data: reds } = ids.length
      ? await db.from("spin_code_redemptions").select("code_id").in("code_id", ids)
      : { data: [] };
    const counts = new Map<string, number>();
    for (const r of (reds ?? []) as { code_id: string }[])
      counts.set(r.code_id, (counts.get(r.code_id) ?? 0) + 1);
    return {
      ready: true,
      rows: ((data ?? []) as any[]).map((c) => ({
        id: c.id as string,
        code: c.code as string,
        kind: c.kind as "real" | "demo",
        spins: c.spins as number,
        startsAt: c.starts_at as string,
        expiresAt: c.expires_at as string,
        maxRedemptions: (c.max_redemptions as number | null) ?? null,
        disabled: !!c.disabled,
        note: c.note as string,
        redeemed: counts.get(c.id) ?? 0,
      })),
    };
  });

export const adminDisableSpinCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    await db.from("spin_codes").update({ disabled: true }).eq("id", data.id);
    await db
      .from("audit_log")
      .insert({ actor: context.userId, action: "code.disabled", details: { id: data.id } });
    return { ok: true };
  });
