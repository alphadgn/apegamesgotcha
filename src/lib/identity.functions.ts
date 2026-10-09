// Player identity: verified wallets (SIWE), public profile (alias/avatar), linked X account and
// verified result shares (player + admin review).
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const addr = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const AVATARS = ["ape-1", "ape-2", "ape-3", "ape-4", "ape-5", "ape-6", "ape-7", "ape-8"] as const;

// ---------------------------------------------------------------- wallets (SIWE)

export const createWalletChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: addr, chainId: z.number().int().positive() }).parse(d))
  .handler(async ({ data, context }) => {
    const siwe = await import("./siwe.server");
    const req = getRequest();
    const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
    return siwe.createChallenge(context.userId, data.address, data.chainId, origin);
  });

export const verifyWalletChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ nonce: z.string().regex(/^[A-Za-z0-9]{16,64}$/), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000) }).parse(d))
  .handler(async ({ data, context }) => {
    const siwe = await import("./siwe.server");
    const w = await siwe.verifyChallenge(context.userId, data.nonce, data.signature as `0x${string}`);
    return { address: (w as { address: string }).address };
  });

// ---------------------------------------------------------------- profile

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const [{ data: p }, { data: wallets }, { data: x }] = await Promise.all([
      db.from("profiles").select("public_id, public_alias, avatar_key, display_name").eq("id", context.userId).single(),
      db.from("wallets").select("id, address, is_default, kind, verification_method, verified_chain_id, is_contract, verified_at").eq("user_id", context.userId).order("verified_at"),
      db.from("x_accounts").select("id, handle, verification_method, linked_at").eq("user_id", context.userId).is("unlinked_at", null).maybeSingle(),
    ]);
    return { profile: p, wallets: wallets ?? [], x: x ?? null, avatars: AVATARS };
  });

export const setPublicProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ alias: z.string().max(24).nullable(), avatar: z.enum(AVATARS).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const p = await h.rpc("set_public_profile", { _user: context.userId, _alias: data.alias, _avatar: data.avatar });
    await h.audit(context.userId, "profile.public_updated", data);
    return p;
  });

// ---------------------------------------------------------------- X account + shares

export const getShareSettings = createServerFn({ method: "GET" }).handler(async () => {
  const x = await import("./xverify.server");
  const h = await import("./helpers.server");
  const mode = await x.verificationMode();
  const db = await h.adminDb();
  const { data: s } = await db.rpc("current_season");
  const season = s as { id: string | null; rules?: { points?: { x_share?: string }; limits?: { x_shares_per_utc_day?: number } } } | null;
  const points = season?.id ? season.rules?.points?.x_share ?? "0" : "0";
  const perDay = season?.id ? season.rules?.limits?.x_shares_per_utc_day ?? 0 : 0;
  return { mode, points, perDay, enabled: mode !== "disabled" && points !== "0" && perDay > 0 };
});

/** Link an X handle. With OAuth unavailable this is a claim that review verifies (author must match). */
export const linkXAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ handle: z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    const handle = data.handle.replace(/^@/, "");
    const a = await h.rpc("link_x_account", { _user: context.userId, _handle: handle, _x_user_id: null, _method: "manual" });
    await h.audit(context.userId, "x.linked", { handle });
    return a;
  });

export const submitShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ postUrl: z.string().url().max(300), spinId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const x = await import("./xverify.server");
    const h = await import("./helpers.server");
    const mode = await x.verificationMode();
    if (mode === "disabled") throw new Error("Share rewards aren't open right now");
    if (!x.normalizePostUrl(data.postUrl)) throw new Error("Paste the link to your post on x.com");
    const sh = await h.rpc<{ id: string; status: string }>("submit_social_share", { _user: context.userId, _post_url: data.postUrl, _spin: data.spinId, _verifier: mode });
    if (mode === "x_api") {
      const out = await x.verifyShareViaApi(sh.id);
      return { id: sh.id, status: (out as { status: string }).status };
    }
    return { id: sh.id, status: sh.status };
  });

export const getMyShares = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    const db = await h.adminDb();
    const { data, error } = await db.from("social_shares").select("id, spin_id, post_url, status, submitted_at, award_day, decision_reason").eq("user_id", context.userId).order("submitted_at", { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// ---------------------------------------------------------------- admin review

export const adminShareQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const db = await h.adminDb();
    const { data, error } = await db.from("social_shares").select("*, x_accounts(handle, x_user_id)").eq("status", "pending").order("submitted_at").limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * Manual review of public content: the admin opened the post and confirms who wrote it, when, and that
 * it references the spin. Every field is recorded as evidence. Never rewards on submission alone.
 */
export const adminReviewShare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      id: z.string().uuid(),
      approve: z.boolean(),
      authorHandle: z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/).optional(),
      postCreatedAt: z.string().datetime().optional(),
      referencesSpin: z.boolean(),
      note: z.string().max(500).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const h = await import("./helpers.server");
    await h.assertAdmin(context.userId);
    const r = await h.rpc("review_social_share", {
      _share: data.id,
      _approve: data.approve,
      _verifier: "manual",
      _reviewer: context.userId,
      _author_x_user_id: null,
      _author_handle: data.authorHandle?.replace(/^@/, "") ?? null,
      _post_created_at: data.postCreatedAt ?? null,
      _references_spin: data.referencesSpin,
      _evidence: { reviewer_note: data.note ?? null, reviewed_via: "manual public content check" },
      _reason: data.note ?? null,
    });
    await h.audit(context.userId, "share.reviewed", data);
    return r;
  });
