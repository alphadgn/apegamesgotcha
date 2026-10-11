// Wallet ownership proof for sign-in and for linking Glyph: after Glyph's "Approve", the player's Glyph wallet
// signs a one-time message (no transaction, no gas). The message is issued by this server and sealed with an
// HMAC, so it can't be made up or reused later; the signature is checked on ApeChain (works for plain wallets
// and smart-contract wallets, ERC-1271 / ERC-6492).
import { createPublicClient, getAddress, isAddress, verifyMessage, type Hex } from "viem";

/** How long a sign-in message stays valid. */
const MAX_AGE_MS = 10 * 60_000;
const APECHAIN_ID = 33139;

function secret() {
  // Server-only secret (never sent to the browser). A dedicated one can be set; otherwise the service key.
  const s = process.env["SIGNIN_PROOF_SECRET"] ?? process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!s) throw new Error("Sign-in isn't configured on the server.");
  return s;
}

async function hmac(message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh message for this wallet to sign, plus the server's seal on it. */
export async function issueWalletChallenge(address: string, origin: string) {
  if (!isAddress(address)) throw new Error("That isn't a wallet address.");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return "apegamesgotcha.com";
    }
  })();
  const message = [
    `${host} wants you to sign in with your wallet:`,
    getAddress(address),
    "",
    "Sign in to ApeGames Gotcha. This proves you own this wallet. It's free: no transaction and no gas.",
    "",
    `Chain ID: ${APECHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  return { message, token: await hmac(message) };
}

export type WalletProof = { message: string; token: string; signature: string };

/**
 * Checks a signed sign-in message: issued by this server (seal), recent, for one of `wallets`, and signed by
 * that wallet. Returns the wallet that signed.
 */
export async function verifyWalletProof(
  proof: WalletProof,
  wallets: string[],
  rpcUrl?: string,
): Promise<string> {
  if (!sameString(await hmac(proof.message), proof.token))
    throw new Error("This sign-in message wasn't issued by ApeGames Gotcha. Please try again.");
  const lines = proof.message.split("\n");
  const address = lines[1]?.trim() ?? "";
  const issued = Date.parse(lines.find((l) => l.startsWith("Issued At: "))?.slice(11) ?? "");
  if (!isAddress(address)) throw new Error("Invalid sign-in message.");
  if (!Number.isFinite(issued) || Date.now() - issued > MAX_AGE_MS || issued - Date.now() > 60_000)
    throw new Error("The sign-in message expired. Please sign in again.");
  if (!wallets.map((w) => w.toLowerCase()).includes(address.toLowerCase()))
    throw new Error(
      "The message was signed for a different wallet than the one you signed in with.",
    );
  const sig = {
    address: address as Hex,
    message: proof.message,
    signature: proof.signature as Hex,
  };
  // Regular wallets (Glyph's included): checked right here. Smart-contract wallets: checked on ApeChain.
  let ok = await verifyMessage(sig).catch(() => false);
  if (!ok) {
    const { resilientTransport } = await import("./rpc.server");
    const client = createPublicClient({ transport: resilientTransport(33139, rpcUrl) });
    ok = await client.verifyMessage(sig).catch(() => false);
  }
  if (!ok) throw new Error("The wallet signature didn't check out. Please sign in again.");
  return address.toLowerCase();
}
