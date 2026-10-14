// ApeGamesLevels (contracts/ApeGamesLevels.sol) on ApeChain: on-chain burn counter + game-set NFT levels.
// The address lives in app_config.nft.level_contract. Writes are signed by the operator wallet
// (VRF_OPERATOR_PRIVATE_KEY, the same key works on ApeChain) and need a little APE for gas. Server only.
import { createPublicClient, createWalletClient, parseAbi, getAddress, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainDef, resilientTransport } from "./rpc.server";
import { LEVEL_TRACKER_BYTECODE } from "./levelTrackerBytecode.server";
import { APEGAMES_NFT_CONTRACT } from "./nft.server";

export const LEVEL_TRACKER_ABI = parseAbi([
  "constructor(address _collection, address _operator)",
  "function recordBurn(uint256 tokenId, address player, uint256 level)",
  "function setLevel(uint256 tokenId, uint256 level)",
  "function levelOf(uint256 tokenId) view returns (uint256)",
  "function totalBurns() view returns (uint256)",
  "function burned(uint256) view returns (bool)",
]);
const CHAIN = 33139;
const RPC = { privateEnv: "APECHAIN_RPC_URL" };

export function operatorAccount() {
  const raw = process.env["VRF_OPERATOR_PRIVATE_KEY"]?.trim();
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return null;
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}
function reader() {
  return createPublicClient({ chain: chainDef(CHAIN), transport: resilientTransport(CHAIN, undefined, RPC) });
}
function writer() {
  const account = operatorAccount();
  if (!account) throw new Error("The operator wallet key isn't set.");
  return createWalletClient({ account, chain: chainDef(CHAIN), transport: resilientTransport(CHAIN, undefined, RPC) });
}

export async function trackerStatus(address: string | null | undefined) {
  const acct = operatorAccount();
  const c = reader();
  const balance = acct ? formatEther(await c.getBalance({ address: acct.address })) : null;
  let totalBurns: string | null = null;
  if (address) totalBurns = String(await c.readContract({ address: getAddress(address), abi: LEVEL_TRACKER_ABI, functionName: "totalBurns" }).catch(() => null) ?? "");
  return { operator: acct?.address ?? null, apeBalance: balance, contract: address ?? null, totalBurns };
}

/** Deploys the tracker for the collection, with the operator wallet as owner and operator. */
export async function deployTracker(collection?: string) {
  const w = writer();
  const c = reader();
  const hash = await w.deployContract({
    abi: LEVEL_TRACKER_ABI,
    bytecode: LEVEL_TRACKER_BYTECODE,
    args: [getAddress(collection || APEGAMES_NFT_CONTRACT), w.account.address],
  });
  const r = await c.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error("Deploying the level tracker failed on ApeChain.");
  return { address: r.contractAddress.toLowerCase(), tx: hash };
}

export async function trackerLevel(address: string, tokenId: bigint): Promise<number | null> {
  const l = await reader().readContract({ address: getAddress(address), abi: LEVEL_TRACKER_ABI, functionName: "levelOf", args: [tokenId] }).catch(() => null);
  return l && l > 0n ? Number(l) : null;
}

export async function trackerRecordBurn(address: string, tokenId: bigint, player: string, level: number) {
  const c = reader();
  if (await c.readContract({ address: getAddress(address), abi: LEVEL_TRACKER_ABI, functionName: "burned", args: [tokenId] })) return null;
  return writer().writeContract({ address: getAddress(address), abi: LEVEL_TRACKER_ABI, functionName: "recordBurn", args: [tokenId, getAddress(player), BigInt(level)] });
}

export async function trackerSetLevel(address: string, tokenId: bigint, level: number) {
  return writer().writeContract({ address: getAddress(address), abi: LEVEL_TRACKER_ABI, functionName: "setLevel", args: [tokenId, BigInt(level)] });
}
