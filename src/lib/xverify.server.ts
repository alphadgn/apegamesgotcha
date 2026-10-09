// Verified X result shares. Only api.x.com is ever called (by numeric post id) — never arbitrary URLs.
// Without X API credentials, shares go to an audited manual review queue (or stay disabled).
import { adminDb, getConfigOr, rpc } from "./helpers.server";

export type SocialCfg = { verification?: "disabled" | "manual" | "x_api"; site_origin?: string };

const POST_URL =
  /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/([0-9]{1,25})(?:[/?#].*)?$/;

/** x.com / twitter.com status URL -> numeric post id (null for anything else). */
export function normalizePostUrl(url: string): string | null {
  const m = POST_URL.exec(url.trim());
  return m ? m[2]! : null;
}

/** The verification mode in force: x_api only with a bearer token; manual only if chosen. */
export async function verificationMode(): Promise<"disabled" | "manual" | "x_api"> {
  const cfg = await getConfigOr<SocialCfg>("social", {});
  if (cfg.verification === "x_api" && process.env["X_BEARER_TOKEN"]) return "x_api";
  if (cfg.verification === "manual" || cfg.verification === "x_api") return "manual";
  return "disabled";
}

export type XPost = {
  id: string;
  authorId: string;
  username: string | null;
  createdAt: Date;
  text: string;
  urls: string[];
};

export async function fetchPost(
  postId: string,
  bearer = process.env["X_BEARER_TOKEN"],
): Promise<XPost> {
  if (!/^[0-9]{1,25}$/.test(postId)) throw new Error("Bad post id");
  if (!bearer) throw new Error("X API is not configured");
  const u = new URL(`https://api.x.com/2/tweets/${postId}`);
  u.searchParams.set("tweet.fields", "created_at,author_id,entities");
  u.searchParams.set("expansions", "author_id");
  u.searchParams.set("user.fields", "username");
  const r = await fetch(u, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) throw Object.assign(new Error("Post not found"), { definite: true });
  if (!r.ok) throw new Error(`X API ${r.status}`);
  const body = (await r.json()) as {
    data?: {
      id: string;
      author_id: string;
      created_at: string;
      text: string;
      entities?: { urls?: { expanded_url?: string; url?: string }[] };
    };
    includes?: { users?: { id: string; username: string }[] };
    errors?: { detail?: string }[];
  };
  if (!body.data)
    throw Object.assign(new Error(body.errors?.[0]?.detail ?? "Post unavailable"), {
      definite: true,
    });
  const user = body.includes?.users?.find((x) => x.id === body.data!.author_id);
  return {
    id: body.data.id,
    authorId: body.data.author_id,
    username: user?.username ?? null,
    createdAt: new Date(body.data.created_at),
    text: body.data.text,
    urls: (body.data.entities?.urls ?? [])
      .map((x) => x.expanded_url ?? x.url ?? "")
      .filter(Boolean),
  };
}

/** The post must point at this spin: its share link (/spin/<id>) or the spin id itself. */
export function referencesSpin(post: Pick<XPost, "text" | "urls">, spinId: string) {
  const id = spinId.toLowerCase();
  return [post.text, ...post.urls].some(
    (s) => s.toLowerCase().includes(`/spin/${id}`) || s.toLowerCase().includes(id),
  );
}

/** Try API verification for a pending share. API failures leave it pending (manual review can take over). */
export async function verifyShareViaApi(shareId: string) {
  const db = await adminDb();
  const { data: sh } = await db.from("social_shares").select("*").eq("id", shareId).single();
  if (!sh || sh.status !== "pending") return sh;
  const { data: acct } = await db.from("x_accounts").select("*").eq("id", sh.x_account_id).single();
  try {
    const post = await fetchPost(sh.post_id);
    return rpc("review_social_share", {
      _share: sh.id,
      _approve: true,
      _verifier: "x_api",
      _reviewer: null,
      _author_x_user_id: post.authorId,
      _author_handle: post.username,
      _post_created_at: post.createdAt.toISOString(),
      _references_spin: referencesSpin(post, sh.spin_id),
      _evidence: {
        source: "x_api_v2",
        author_id: post.authorId,
        username: post.username,
        created_at: post.createdAt.toISOString(),
        linked_handle: acct?.handle,
      },
      _reason: null,
    });
  } catch (e) {
    if ((e as { definite?: boolean }).definite) {
      return rpc("review_social_share", {
        _share: sh.id,
        _approve: false,
        _verifier: "x_api",
        _reviewer: null,
        _author_x_user_id: null,
        _author_handle: null,
        _post_created_at: null,
        _references_spin: false,
        _evidence: { error: (e as Error).message },
        _reason: (e as Error).message,
      });
    }
    await db
      .from("social_shares")
      .update({
        evidence: {
          ...(sh.evidence ?? {}),
          last_api_error: (e as Error).message,
          last_api_attempt: new Date().toISOString(),
        },
      })
      .eq("id", sh.id);
    return sh;
  }
}

export async function retryPendingApiShares(limit = 25) {
  if ((await verificationMode()) !== "x_api") return { skipped: "x_api not configured" };
  const db = await adminDb();
  const { data } = await db
    .from("social_shares")
    .select("id")
    .eq("status", "pending")
    .eq("verifier", "x_api")
    .order("submitted_at")
    .limit(limit);
  for (const r of (data ?? []) as { id: string }[]) await verifyShareViaApi(r.id);
  return { retried: (data ?? []).length };
}
