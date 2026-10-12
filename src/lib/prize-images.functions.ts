// Prize pictures live in the private prize-images bucket, which nobody can read directly (drizzle 0013).
// The server hands out short-lived signed links, and only for pictures the caller may see:
//   - anyone: photos of active prizes (prize pool, machine reveal)
//   - a signed-in player: also photos of prizes they won (Your IRL prizes)
//   - an admin: any prize picture (Prizes & odds, including a fresh upload not saved yet)
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

const pathsSchema = z.object({ paths: z.array(z.string().min(1).max(300)).min(1).max(40) });
const LINK_SECONDS = 3600;

async function sign(db: any, paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data } = await db.storage.from("prize-images").createSignedUrls(paths, LINK_SECONDS);
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { path: string | null; signedUrl: string | null }[])
    if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
  return out;
}

/** Public: signed links for photos of active prizes. */
export const getPrizeImageUrls = createServerFn({ method: "POST" })
  .inputValidator((d) => pathsSchema.parse(d))
  .handler(async ({ data }) => {
    const db = await admin();
    const { data: rows } = await db.from("prizes").select("image_url").eq("active", true).in("image_url", data.paths);
    const allowed = ((rows ?? []) as { image_url: string }[]).map((r) => r.image_url);
    return { urls: await sign(db, [...new Set(allowed)]) };
  });

/** Signed in: also photos of prizes this player won; admins: any prize picture. */
export const getMyPrizeImageUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => pathsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const { data: role } = await db
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (role) return { urls: await sign(db, data.paths) };
    const { data: prizes } = await db.from("prizes").select("id, image_url, active").in("image_url", data.paths);
    const list = (prizes ?? []) as { id: string; image_url: string; active: boolean }[];
    const allowed = new Set(list.filter((p) => p.active).map((p) => p.image_url));
    const rest = list.filter((p) => !p.active);
    if (rest.length) {
      const { data: won } = await db
        .from("spins")
        .select("prize_id")
        .eq("user_id", context.userId)
        .eq("status", "fulfilled")
        .in("prize_id", rest.map((p) => p.id));
      const wonIds = new Set(((won ?? []) as { prize_id: string }[]).map((w) => w.prize_id));
      rest.filter((p) => wonIds.has(p.id)).forEach((p) => allowed.add(p.image_url));
    }
    return { urls: await sign(db, [...allowed]) };
  });
