// Verified X result shares. The server never fetches a player-supplied URL: links are reduced to a
// numeric post id. Optional automatic verification calls only the fixed X API endpoint with an app bearer
// token (X_API_BEARER_TOKEN). Any API failure leaves the share pending for audited manual review.

const STATUS_URL =
  /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/web|i)\/status(?:es)?\/([0-9]{5,25})(?:[/?#].*)?$/;

/** Mirrors public.normalize_x_post_url (the database re-checks). */
export function normalizeXPostUrl(url: string): string | null {
  const m = STATUS_URL.exec(url.trim());
  return m?.[1] ?? null;
}

/** Short code printed on each share card so a post can be matched to its spin (mirrors public.spin_share_code). */
export function spinShareCode(spinId: string) {
  return `AGG-${spinId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export type ShareEvidence = {
  author_username: string;
  author_x_user_id: string;
  post_created_at: string;
  references_spin: boolean;
  public: boolean;
  source: "x_api";
  checked_at: string;
};

/** Look a post up through the X API v2 (fixed host). Returns null when unavailable for any reason. */
export async function fetchPostEvidence(
  postId: string,
  shareCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShareEvidence | null> {
  const token = process.env["X_API_BEARER_TOKEN"];
  if (!token || !/^[0-9]{5,25}$/.test(postId)) return null;
  try {
    const url = `https://api.x.com/2/tweets/${postId}?expansions=author_id&tweet.fields=created_at,text&user.fields=username`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { id?: string; text?: string; created_at?: string; author_id?: string };
      includes?: { users?: { id?: string; username?: string }[] };
    };
    const d = body.data;
    const user = body.includes?.users?.find((u) => u.id === d?.author_id);
    if (!d?.id || d.id !== postId || !d.created_at || !d.author_id || !user?.username) return null;
    return {
      author_username: user.username,
      author_x_user_id: d.author_id,
      post_created_at: d.created_at,
      references_spin: (d.text ?? "").toUpperCase().includes(shareCode.toUpperCase()),
      public: true, // readable with an app-only token means it is public
      source: "x_api",
      checked_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
