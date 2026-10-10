// Server-side Privy helpers: verify a Privy access token and read the user's linked accounts.
// Uses WebCrypto only (no SDK), so it runs on the Cloudflare worker build too.

type Jwk = JsonWebKey & { kid?: string };
const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();

function b64urlToBytes(s: string) {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s: string) =>
  JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as Record<string, unknown>;

async function jwks(appId: string, force = false) {
  const hit = jwksCache.get(appId);
  if (hit && !force && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const r = await fetch(
    `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!r.ok) throw new Error("Couldn't reach Privy to verify your sign-in. Please try again.");
  const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
  jwksCache.set(appId, { keys, at: Date.now() });
  return keys;
}

/** Verifies a Privy access token (ES256) and returns the Privy user id (did:privy:…). */
export async function verifyPrivyAccessToken(token: string, appId: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid sign-in token");
  const [h, p, sig] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (header["alg"] !== "ES256") throw new Error("Invalid sign-in token");

  let keys = await jwks(appId);
  let jwk = keys.find((k) => !header["kid"] || k.kid === header["kid"]);
  if (!jwk) {
    keys = await jwks(appId, true);
    jwk = keys.find((k) => !header["kid"] || k.kid === header["kid"]);
  }
  if (!jwk) throw new Error("Invalid sign-in token");

  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("Invalid sign-in token");

  const now = Math.floor(Date.now() / 1000);
  const aud = payload["aud"];
  if (payload["iss"] !== "privy.io") throw new Error("Invalid sign-in token");
  if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId))))
    throw new Error("Invalid sign-in token");
  if (typeof payload["exp"] !== "number" || payload["exp"] < now - 30)
    throw new Error("Your sign-in expired. Please sign in again.");
  const sub = payload["sub"];
  if (typeof sub !== "string" || !sub.startsWith("did:privy:"))
    throw new Error("Invalid sign-in token");
  return sub;
}

export type PrivyIdentity = {
  did: string;
  email: string | null;
  wallets: { address: string; kind: "privy" | "external" | "glyph" }[];
};

type LinkedAccount = {
  type?: string;
  address?: string;
  email?: string;
  chain_type?: string;
  wallet_client_type?: string;
  wallet_client?: string;
  connector_type?: string;
  /** "cross_app" accounts (Login with Glyph): the Glyph wallet(s) the player signed in with. */
  embedded_wallets?: { address?: string }[];
  smart_wallets?: { address?: string }[];
  provider_app?: { id?: string; name?: string };
};

/** Reads the user's email and Ethereum wallets from Privy (needs the PRIVY_APP_SECRET secret). */
export async function fetchPrivyIdentity(did: string, appId: string): Promise<PrivyIdentity> {
  const secret = process.env["PRIVY_APP_SECRET"];
  if (!secret)
    throw new Error(
      "Privy sign-in isn't finished being set up (the PRIVY_APP_SECRET secret is missing).",
    );
  const r = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
    headers: { Authorization: `Basic ${btoa(`${appId}:${secret}`)}`, "privy-app-id": appId },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 401 || r.status === 403)
    throw new Error(
      "Privy rejected the app credentials. Check PRIVY_APP_SECRET and the Privy App ID.",
    );
  if (!r.ok) throw new Error("Couldn't load your Privy account. Please try again.");
  const user = (await r.json()) as { linked_accounts?: LinkedAccount[] };
  const accounts = user.linked_accounts ?? [];

  const email =
    accounts.find((a) => a.type === "email" && a.address)?.address ??
    accounts.find((a) => (a.type === "google_oauth" || a.type === "apple_oauth") && a.email)
      ?.email ??
    null;

  const wallets: PrivyIdentity["wallets"] = accounts
    .filter(
      (a) =>
        a.type === "wallet" &&
        (a.chain_type ?? "ethereum") === "ethereum" &&
        /^0x[0-9a-fA-F]{40}$/.test(a.address ?? ""),
    )
    .map((a) => ({
      address: (a.address as string).toLowerCase(),
      kind: (a.wallet_client_type === "privy" || a.connector_type === "embedded"
        ? "privy"
        : "external") as "privy" | "external",
    }));

  // Login with Glyph is a Privy cross-app account: its wallet lives on the Glyph side and comes through here.
  const isAddr = (a?: string): a is string => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
  for (const a of accounts.filter((x) => x.type === "cross_app")) {
    for (const w of [...(a.embedded_wallets ?? []), ...(a.smart_wallets ?? [])]) {
      const address = w.address?.toLowerCase();
      if (isAddr(address) && !wallets.some((x) => x.address === address)) wallets.push({ address, kind: "glyph" });
    }
  }

  return { did, email: email ? email.toLowerCase() : null, wallets };
}
