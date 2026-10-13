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

// ---------- One-time wallet links (Add wallet from a phone wallet app) ----------
// The signed-in player's Add wallet window gets a sealed code; the wallet app's browser opens
// /link-wallet?c=<code>, the wallet signs `walletLinkMessage`, and the server links that wallet to the player who
// made the code. The code is self-contained (sealed with the server secret), so nothing else the player does
// meanwhile — reopening the window, switching apps, another sign-in — can cancel it. It expires after 15 minutes;
// replaying it can only re-add the same wallet to the same account.

const LINK_MAX_AGE_MS = 15 * 60_000;

export async function issueWalletLinkCode(userId: string) {
  const exp = Date.now() + LINK_MAX_AGE_MS;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const body = `${userId}.${exp}.${rand}`;
  return { code: `${body}.${await hmac(`walletlink|${body}`)}`, expiresAt: new Date(exp).toISOString() };
}

export async function readWalletLinkCode(code: string) {
  const parts = code.split(".");
  if (parts.length !== 4) throw new Error("This link isn't valid. Start again from Add wallet.");
  const [userId, expText, rand, mac] = parts as [string, string, string, string];
  const body = `${userId}.${expText}.${rand}`;
  if (!sameString(mac, await hmac(`walletlink|${body}`))) throw new Error("This link isn't valid. Start again from Add wallet.");
  const exp = Number(expText);
  if (!Number.isFinite(exp) || Date.now() > exp) throw new Error("This link expired (links last 15 minutes). Start again from Add wallet.");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("This link isn't valid.");
  return { userId, rand, expiresAt: new Date(exp).toISOString() };
}

/** What the wallet signs for a wallet link (rebuilt by the server from the code, never trusted from the page). */
export function walletLinkMessage(l: { userId: string; rand: string; expiresAt: string }) {
  return `ApeGames Gotcha: add this wallet to my account\nAccount: ${l.userId}\nCode: ${l.rand}\nValid until: ${l.expiresAt}\n\nNo transaction, no fees.`;
}

// ---- Stock certificate claim links (emailed to the winner's account email) ----

/** How long an emailed stock certificate claim link works. */
export const STOCK_CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * A sealed claim link code `certId.exp.rand.mac`. `rand` is also stored on the certificate, so sending a new email
 * (new rand) switches off older links, and the link stops working once the certificate has been sent.
 */
export async function issueStockClaimCode(certId: string, rand: string) {
  const exp = Date.now() + STOCK_CLAIM_MAX_AGE_MS;
  const body = `${certId}.${exp}.${rand}`;
  return { code: `${body}.${await hmac(`stockclaim|${body}`)}`, expiresAt: new Date(exp).toISOString() };
}

export async function readStockClaimCode(code: string) {
  const bad = "This claim link isn't valid. Open the latest email from ApeGames Gotcha, or claim it from My Machine.";
  const parts = code.trim().split(".");
  if (parts.length !== 4) throw new Error(bad);
  const [certId, expText, rand, mac] = parts as [string, string, string, string];
  const body = `${certId}.${expText}.${rand}`;
  if (!sameString(mac, await hmac(`stockclaim|${body}`))) throw new Error(bad);
  if (!/^[0-9a-f-]{36}$/i.test(certId) || !/^[0-9a-f]{16,64}$/.test(rand)) throw new Error(bad);
  const exp = Number(expText);
  if (!Number.isFinite(exp) || Date.now() > exp)
    throw new Error("This claim link expired. Sign in to ApeGames Gotcha and claim the certificate from My Machine, or ask for a new email there.");
  return { certId, rand };
}
