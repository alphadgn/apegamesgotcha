import { createPublicClient, parseAbi, getAddress, type Hex } from "viem";
import { chainDef, resilientTransport } from "./rpc.server";

/** The ApeGames NFT collection ("ApeGames Digital Competition", ERC-721 on ApeChain). */
export const APEGAMES_NFT_CONTRACT = "0x8Bb7b20291A9fA2F25705b8487194B410808c28b";

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
  "function levelOf(uint256) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export function nftClient(cfg: NftConfig) {
  const id = cfg.chain_id || 33139; // ApeChain
  return createPublicClient({ chain: chainDef(id, undefined, cfg.rpc_url), transport: resilientTransport(id, cfg.rpc_url), batch: { multicall: true } });
}

/** The collection's contract: the configured one, or the ApeGames collection when none is set. */
export function nftContract(cfg: NftConfig): Hex {
  return (cfg.contract?.trim() || APEGAMES_NFT_CONTRACT) as Hex;
}

function resolveUri(uri: string) {
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  return uri;
}

export async function fetchLevel(cfg: NftConfig, tokenId: bigint): Promise<number | null> {
  const client = nftClient(cfg);
  // The contract keeps each NFT's level on-chain (levelOf); metadata can be hidden before reveal.
  try {
    const lvl = await client.readContract({
      address: nftContract(cfg),
      abi,
      functionName: "levelOf",
      args: [tokenId],
    });
    if (lvl > 0n) return Number(lvl);
  } catch {
    /* fall back to the metadata trait */
  }
  try {
    const uri = await client.readContract({
      address: nftContract(cfg),
      abi,
      functionName: "tokenURI",
      args: [tokenId],
    });
    const res = await fetch(resolveUri(uri), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const meta = (await res.json()) as { attributes?: { trait_type?: string; value?: unknown }[] };
    const trait = (cfg.level_trait || "Level").toLowerCase();
    const attr = meta.attributes?.find((a) => a.trait_type?.toLowerCase() === trait);
    if (!attr) return null;
    const m = String(attr.value).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

/** Every token of the collection this wallet holds (ERC721Enumerable), read in parallel. */
export async function listOwnedTokens(cfg: NftConfig, owner: string): Promise<bigint[]> {
  const client = nftClient(cfg);
  const address = nftContract(cfg);
  const who = getAddress(owner);
  const bal = await client.readContract({ address, abi, functionName: "balanceOf", args: [who] });
  const n = Number(bal > 200n ? 200n : bal);
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      client.readContract({
        address,
        abi,
        functionName: "tokenOfOwnerByIndex",
        args: [who, BigInt(i)],
      }),
    ),
  );
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Thrown while the burn transaction isn't mined yet, so callers can keep waiting. */
export class BurnPendingError extends Error {}

export async function verifyBurnTx(
  cfg: NftConfig,
  txHash: Hex,
  tokenId: bigint,
  fromWallets: string[],
) {
  const client = nftClient(cfg);
  const receipt = await client
    .getTransactionReceipt({ hash: txHash })
    .catch((e: { name?: string }) => {
      if (e?.name === "TransactionReceiptNotFoundError")
        throw new BurnPendingError("Waiting for ApeChain to confirm the burn");
      throw e;
    });
  if (receipt.status !== "success") throw new Error("Transaction failed on-chain");
  const burnTargets = [
    cfg.burn_address.toLowerCase(),
    "0x0000000000000000000000000000000000000000",
  ];
  const wallets = fromWallets.map((w) => w.toLowerCase());
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== nftContract(cfg).toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 4) continue;
    const from = ("0x" + log.topics[1]!.slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2]!.slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]!);
    if (id === tokenId && wallets.includes(from) && burnTargets.includes(to)) return true;
  }
  throw new Error("No matching burn transfer from your linked wallet found in this transaction");
}
