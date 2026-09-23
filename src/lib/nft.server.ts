import { createPublicClient, http, parseAbi, getAddress, type Hex } from "viem";

export type NftConfig = {
  contract: string;
  chain_id: number;
  rpc_url: string;
  level_trait: string;
  burn_min_level: number;
  burn_address: string;
};

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export function nftClient(cfg: NftConfig) {
  return createPublicClient({ transport: http(cfg.rpc_url) });
}

function resolveUri(uri: string) {
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  return uri;
}

export async function fetchLevel(cfg: NftConfig, tokenId: bigint): Promise<number | null> {
  try {
    const client = nftClient(cfg);
    const uri = await client.readContract({ address: cfg.contract as Hex, abi, functionName: "tokenURI", args: [tokenId] });
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

export async function listOwnedTokens(cfg: NftConfig, owner: string): Promise<bigint[]> {
  const client = nftClient(cfg);
  const address = cfg.contract as Hex;
  const bal = await client.readContract({ address, abi, functionName: "balanceOf", args: [getAddress(owner)] });
  const n = Number(bal > 200n ? 200n : bal);
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await client.readContract({ address, abi, functionName: "tokenOfOwnerByIndex", args: [getAddress(owner), BigInt(i)] }));
  }
  return ids;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function verifyBurnTx(cfg: NftConfig, txHash: Hex, tokenId: bigint, fromWallets: string[]) {
  const client = nftClient(cfg);
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Transaction failed on-chain");
  const burnTargets = [cfg.burn_address.toLowerCase(), "0x0000000000000000000000000000000000000000"];
  const wallets = fromWallets.map((w) => w.toLowerCase());
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== cfg.contract.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 4) continue;
    const from = ("0x" + log.topics[1]!.slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2]!.slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]!);
    if (id === tokenId && wallets.includes(from) && burnTargets.includes(to)) return true;
  }
  throw new Error("No matching burn transfer from your linked wallet found in this transaction");
}
