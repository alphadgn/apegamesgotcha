// Live NFT reads (display + burn eligibility) and burn verification. Historical snapshot recognition
// lives in snapshot.server.ts and never uses these live reads.
import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  parseEventLogs,
  type Hex,
  type PublicClient,
} from "viem";

export type NftConfig = {
  contract: string;
  chain_id: number;
  rpc_url: string;
  level_trait: string;
  burn_min_level: number;
  burn_address: string;
  burn_min_confirmations?: number;
};

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export function nftClient(cfg: NftConfig): PublicClient {
  return createPublicClient({ transport: http(cfg.rpc_url), cacheTime: 0 }) as PublicClient;
}

function resolveUri(uri: string) {
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  return uri;
}

/** Level from the token's metadata, optionally as of a past block (archive RPC). */
export async function fetchLevel(
  cfg: NftConfig,
  tokenId: bigint,
  opts: { client?: PublicClient; blockNumber?: bigint } = {},
): Promise<number | null> {
  try {
    const client = opts.client ?? nftClient(cfg);
    const uri = await client.readContract({
      address: cfg.contract as Hex,
      abi,
      functionName: "tokenURI",
      args: [tokenId],
      ...(opts.blockNumber != null ? { blockNumber: opts.blockNumber } : {}),
    });
    const url = resolveUri(uri);
    if (!/^https:\/\//.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const meta = (await res.json()) as { attributes?: { trait_type?: string; value?: unknown }[] };
    const attr = meta.attributes?.find(
      (a) => a.trait_type?.toLowerCase() === cfg.level_trait.toLowerCase(),
    );
    if (!attr) return null;
    const m = String(attr.value).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Tokens a wallet holds right now (for display / burn eligibility only). Pages through every holding
 * (no 200 cap). Non-enumerable collections report `enumerable: false` instead of guessing.
 */
export async function listOwnedTokens(
  cfg: NftConfig,
  owner: string,
  opts: { client?: PublicClient; max?: number } = {},
) {
  const client = opts.client ?? nftClient(cfg);
  const address = cfg.contract as Hex;
  const who = getAddress(owner);
  const bal = await client.readContract({ address, abi, functionName: "balanceOf", args: [who] });
  const n = Number(bal > BigInt(opts.max ?? 5000) ? BigInt(opts.max ?? 5000) : bal);
  const ids: bigint[] = [];
  try {
    for (let i = 0; i < n; i += 25) {
      const page = await Promise.all(
        Array.from({ length: Math.min(25, n - i) }, (_, k) =>
          client.readContract({
            address,
            abi,
            functionName: "tokenOfOwnerByIndex",
            args: [who, BigInt(i + k)],
          }),
        ),
      );
      ids.push(...page);
    }
  } catch {
    return { ids: [] as bigint[], enumerable: false as const, balance: Number(bal) };
  }
  return { ids, enumerable: true as const, balance: Number(bal) };
}

const TRANSFER_TARGET_ZERO = "0x0000000000000000000000000000000000000000";

export type BurnEvidence = {
  chainId: number;
  contract: string;
  tokenId: string;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  blockNumber: bigint;
  blockHash: string;
  confirmations: number;
};

/**
 * Verify a burn on the configured chain: successful receipt at finalized depth on the canonical chain,
 * the configured contract, this token, from one of the player's linked wallets, to the burn target.
 */
export async function verifyBurn(
  cfg: NftConfig,
  txHash: Hex,
  tokenId: bigint,
  linkedWallets: string[],
  client?: PublicClient,
): Promise<BurnEvidence> {
  const pub = client ?? nftClient(cfg);
  const chainId = await pub.getChainId();
  if (chainId !== cfg.chain_id) throw new Error("Burn RPC is on the wrong chain");
  const receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt)
    throw new Error("Transaction not found yet. Wait for it to confirm, then try again.");
  if (receipt.status !== "success") throw new Error("Transaction failed on-chain");
  const head = await pub.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber + 1n);
  const min = cfg.burn_min_confirmations ?? 12;
  if (confirmations < min)
    throw new Error(`Burn is confirming (${confirmations}/${min} blocks). Try again in a minute.`);
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new Error("Burn block is not canonical yet. Try again shortly.");
  const targets = [cfg.burn_address.toLowerCase(), TRANSFER_TARGET_ZERO];
  const wallets = linkedWallets.map((w) => w.toLowerCase());
  const transfers = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" });
  for (const l of transfers) {
    if (l.address.toLowerCase() !== cfg.contract.toLowerCase()) continue;
    if (l.args.tokenId !== tokenId) continue;
    const from = l.args.from.toLowerCase();
    const to = l.args.to.toLowerCase();
    if (!wallets.includes(from) || !targets.includes(to)) continue;
    return {
      chainId,
      contract: cfg.contract.toLowerCase(),
      tokenId: tokenId.toString(),
      txHash: txHash.toLowerCase(),
      logIndex: Number(l.logIndex),
      from,
      to,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      confirmations,
    };
  }
  throw new Error("No matching burn transfer from your linked wallet found in this transaction");
}
