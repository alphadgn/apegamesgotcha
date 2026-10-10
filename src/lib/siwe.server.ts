// Sign-In-With-Ethereum (EIP-4361) wallet challenges: bound to this site's domain/URI and a chain,
// single-use and expiring. Verification goes through the chain's RPC so smart-contract wallets
// (ERC-1271, and ERC-6492 for not-yet-deployed wallets) work as well as ordinary accounts.
import { getAddress, type Hex, type PublicClient } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";

export const CHALLENGE_TTL_SECONDS = 600;

/** The site the request came from. Only same-origin requests (or explicitly allowed origins) are accepted. */
export function siteFromRequest(
  request: Request,
  allowedOrigins: string[] = [],
): { domain: string; uri: string } {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin) throw new Error("Missing Origin header");
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    throw new Error("Invalid Origin header");
  }
  const allowed = allowedOrigins.map((a) => a.replace(/\/$/, "").toLowerCase());
  if (o.host !== host && !allowed.includes(o.origin.toLowerCase()))
    throw new Error("Wallet signatures must come from this site");
  if (o.protocol !== "https:" && o.hostname !== "localhost" && o.hostname !== "127.0.0.1")
    throw new Error("Wallet signatures need HTTPS");
  return { domain: o.host, uri: `${o.origin}/dashboard` };
}

export function buildChallenge(input: {
  address: string;
  chainId: number;
  domain: string;
  uri: string;
  now?: Date;
  ttlSeconds?: number;
  nonce?: string;
}) {
  const issuedAt = input.now ?? new Date();
  const expirationTime = new Date(
    issuedAt.getTime() + (input.ttlSeconds ?? CHALLENGE_TTL_SECONDS) * 1000,
  );
  const nonce = input.nonce ?? generateSiweNonce();
  const message = createSiweMessage({
    address: getAddress(input.address),
    chainId: input.chainId,
    domain: input.domain,
    uri: input.uri,
    nonce,
    version: "1",
    issuedAt,
    expirationTime,
    statement:
      "Link this wallet to my ApeGames Gotcha account. This does not send a transaction or cost gas.",
  });
  return { message, nonce, issuedAt, expirationTime };
}

/**
 * Verify a signature over the exact message we issued (read back from the database, never from the client).
 * Returns the parsed fields on success; throws with a player-readable reason otherwise.
 */
export async function verifyChallengeSignature(
  pub: PublicClient,
  stored: { message: string; address: string; chain_id: number; domain: string; nonce: string },
  signature: Hex,
  now = new Date(),
) {
  const parsed = parseSiweMessage(stored.message);
  if (
    parsed.nonce !== stored.nonce ||
    parsed.domain !== stored.domain ||
    parsed.chainId !== stored.chain_id
  ) {
    throw new Error("Signature request doesn't match");
  }
  if (!parsed.address || parsed.address.toLowerCase() !== stored.address.toLowerCase())
    throw new Error("Signed by a different wallet than requested");
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= now.getTime())
    throw new Error("This signature request expired. Request a new one.");
  const chainId = await pub.getChainId();
  if (chainId !== stored.chain_id) throw new Error("Wallet verification RPC is on the wrong chain");
  const ok = await pub.verifySiweMessage({
    message: stored.message,
    signature,
    address: getAddress(stored.address),
    domain: stored.domain,
    nonce: stored.nonce,
    time: now,
  });
  if (!ok) throw new Error("Signature does not match this wallet");
  return parsed;
}
