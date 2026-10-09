// Live NFT display / burn verification (separate from immutable historical snapshot claims).
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Hex, type PublicClient } from "viem";

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
  "function ownerOf(uint256) view returns (address)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

export function nftClient(cfg: NftConfig): PublicClient {
  return createPublicClient({ transport: http(cfg.rpc_url, { timeout: 15_000 }) }) as PublicClient;
}

function resolveUri(uri: string) {
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  return uri;
}

/** Level from metadata at a given block (pre-burn state when `blockNumber` is set). */
export async function fetchLevel(cfg: NftConfig, tokenId: bigint, blockNumber?: bigint): Promise<number | null> {
  try {
    const client = nftClient(cfg);
    const uri = await client.readContract({
      address: cfg.contract as Hex,
      abi,
      functionName: "tokenURI",
      args: [tokenId],
      ...(blockNumber != null ? { blockNumber } : {}),
    });
    if (!/^(https:|ipfs:)/.test(uri)) return null; // never fetch arbitrary schemes
    const res = await fetch(resolveUri(uri), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const meta = (await res.json()) as { attributes?: { trait_type?: string; value?: unknown }[] };
    const attr = meta.attributes?.find((a) => a.trait_type?.toLowerCase() === cfg.level_trait.toLowerCase());
    if (!attr) return null;
    const m = String(attr.value).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Tokens currently held (for display and burn eligibility only — never for points).
 * Uses ERC-721 Enumerable when available; otherwise reconstructs ownership from Transfer logs,
 * so non-enumerable collections and any number of holdings work.
 */
export async function listOwnedTokens(cfg: NftConfig, owner: string, opts: { fromBlock?: bigint; chunk?: bigint } = {}): Promise<bigint[]> {
  const client = nftClient(cfg);
  const address = cfg.contract as Hex;
  const who = getAddress(owner);
  try {
    const bal = await client.readContract({ address, abi, functionName: "balanceOf", args: [who] });
    const ids: bigint[] = [];
    for (let i = 0n; i < bal; i++) {
      ids.push(await client.readContract({ address, abi, functionName: "tokenOfOwnerByIndex", args: [who, i] }));
    }
    return ids;
  } catch {
    /* not enumerable — fall back to logs */
  }
  const head = await client.getBlockNumber();
  const chunk = opts.chunk ?? 10_000n;
  const candidates = new Set<bigint>();
  for (let from = opts.fromBlock ?? 0n; from <= head; from += chunk) {
    const to = from + chunk - 1n < head ? from + chunk - 1n : head;
    const logs = await client.getLogs({ address, event: transferEvent, args: { to: who }, fromBlock: from, toBlock: to });
    for (const l of logs) if (l.args.tokenId != null) candidates.add(l.args.tokenId);
  }
  const held: bigint[] = [];
  for (const id of candidates) {
    const cur = await client.readContract({ address, abi, functionName: "ownerOf", args: [id] }).catch(() => null);
    if (cur && cur.toLowerCase() === who.toLowerCase()) held.push(id);
  }
  return held.sort((a, b) => (a < b ? -1 : 1));
}

export type VerifiedBurn = {
  chainId: number;
  contract: string;
  tokenId: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  from: string;
};

/**
 * Verifies a burn: right chain, successful receipt that is canonical and finalized (enough
 * confirmations, block hash matches), a Transfer of this token by this contract from one of the
 * player's verified wallets to the burn target.
 */
export async function verifyBurnTx(cfg: NftConfig, txHash: Hex, tokenId: bigint, fromWallets: string[]): Promise<VerifiedBurn> {
  const client = nftClient(cfg);
  const chainId = await client.getChainId();
  if (chainId !== cfg.chain_id) throw new Error(`NFT RPC is on chain ${chainId}, expected ${cfg.chain_id}`);
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) throw new Error("Transaction not found yet — try again once it's confirmed");
  if (receipt.status !== "success") throw new Error("Transaction failed on-chain");
  const need = BigInt(Math.max(1, cfg.burn_min_confirmations ?? 12));
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < need) throw new Error(`Waiting for ${need} confirmations — try again shortly`);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error("That block is not canonical (reorg) — try again shortly");
  const burnTargets = [cfg.burn_address.toLowerCase(), ZERO];
  const wallets = fromWallets.map((w) => w.toLowerCase());
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.contract.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 4) continue;
    const from = ("0x" + log.topics[1]!.slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2]!.slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]!);
    if (id === tokenId && wallets.includes(from) && burnTargets.includes(to)) {
      return {
        chainId,
        contract: cfg.contract.toLowerCase(),
        tokenId: tokenId.toString(),
        txHash: txHash.toLowerCase(),
        logIndex: Number(log.logIndex),
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash.toLowerCase(),
        from,
      };
    }
  }
  throw new Error("No matching burn transfer from your verified wallet found in this transaction");
}
