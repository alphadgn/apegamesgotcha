// Wallet ownership proof with Sign-In with Ethereum (EIP-4361): bound to an allowed domain/URI and
// chain, expiring, consume-once nonces (atomic in Postgres). EOAs and contract wallets (ERC-1271,
// and ERC-6492 for undeployed smart accounts) are verified through the chain's RPC.
import { createPublicClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import { adminDb, getConfigOr, rpc } from "./helpers.server";

export type SiweCfg = {
  allowed_origins?: string[];
  statement?: string;
  ttl_minutes?: number;
  chains?: Record<string, string>;
};

export async function siweClient(chainId: number): Promise<PublicClient> {
  const cfg = await getConfigOr<SiweCfg>("siwe", {});
  const url = cfg.chains?.[String(chainId)];
  if (!url) throw new Error(`Chain ${chainId} isn't supported for wallet verification`);
  return createPublicClient({ transport: http(url, { timeout: 15_000 }) }) as PublicClient;
}

/** The request's origin must be one of siwe.allowed_origins (exact match). */
export async function resolveOrigin(requestOrigin: string | null | undefined) {
  const cfg = await getConfigOr<SiweCfg>("siwe", {});
  const allowed = (cfg.allowed_origins ?? []).map((o) => o.replace(/\/$/, ""));
  const origin = (requestOrigin ?? "").replace(/\/$/, "");
  if (!allowed.length)
    throw new Error(
      "Wallet verification isn't set up yet (Admin → Configuration → siwe.allowed_origins)",
    );
  if (!allowed.includes(origin))
    throw new Error("This site address isn't allowed to request wallet signatures");
  return { origin, domain: new URL(origin).host };
}

export async function createChallenge(
  userId: string,
  address: string,
  chainId: number,
  requestOrigin: string | null,
) {
  const cfg = await getConfigOr<SiweCfg>("siwe", {});
  const { origin, domain } = await resolveOrigin(requestOrigin);
  if (!cfg.chains?.[String(chainId)])
    throw new Error(`Chain ${chainId} isn't supported for wallet verification`);
  const nonce = generateSiweNonce();
  const issuedAt = new Date();
  const ttl = Math.min(Math.max(cfg.ttl_minutes ?? 10, 1), 30);
  const expirationTime = new Date(issuedAt.getTime() + ttl * 60_000);
  const message = createSiweMessage({
    domain,
    address: getAddress(address),
    statement: cfg.statement ?? "Link this wallet to your ApeGames Gotcha account.",
    uri: origin,
    version: "1",
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  });
  const db = await adminDb();
  const { error } = await db.from("wallet_challenges").insert({
    nonce,
    user_id: userId,
    address: address.toLowerCase(),
    chain_id: chainId,
    domain,
    uri: origin,
    message,
    issued_at: issuedAt.toISOString(),
    expires_at: expirationTime.toISOString(),
  });
  if (error) throw new Error(error.message);
  return { nonce, message };
}

export async function verifyChallenge(userId: string, nonce: string, signature: Hex) {
  // Consume first (atomic, once): a replayed or concurrent submission fails here.
  const ch = await rpc<{
    address: string;
    chain_id: number;
    domain: string;
    message: string;
    nonce: string;
  }>("consume_wallet_challenge", { _nonce: nonce, _user: userId });
  const client = await siweClient(ch.chain_id);
  const address = getAddress(ch.address);
  const valid = await client.verifySiweMessage({
    message: ch.message,
    signature,
    address,
    domain: ch.domain,
    nonce: ch.nonce,
  });
  if (!valid) throw new Error("The signature doesn't match this wallet");
  const code = await client.getCode({ address }).catch(() => undefined);
  const isContract = !!code && code !== "0x";
  return rpc("link_verified_wallet", {
    _user: userId,
    _address: ch.address,
    _kind: "external",
    _method: isContract ? "siwe_erc1271" : "siwe",
    _chain_id: ch.chain_id,
    _is_contract: isContract,
  });
}
