// Server-only helpers for the GotchaVRF contract (Chainlink VRF v2.5).
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gotchaVrfAbi } from "./gotchaVrfAbi";

export type VrfConfig = {
  enabled: boolean;
  chain?: string;
  chain_id: number;
  rpc_url: string;
  contract: string;
  explorer_url?: string;
  max_batch?: number;
  draw_timeout_sec?: number;
};

export const UNLIMITED = 0xffffffff;
export const NO_PRIZE = 255;
/** Mirrors GotchaVRF.Status */
export const ChainStatus = { None: 0, Pending: 1, Fulfilled: 2, Cancelled: 3 } as const;

export function uuidToBytes32(id: string): Hex {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Bad spin id: ${id}`);
  return `0x${hex.padStart(64, "0")}`;
}

export function requireVrf(cfg: VrfConfig | null | undefined): VrfConfig {
  if (!cfg?.enabled) throw new Error("Spins are paused while the Chainlink VRF draw is being set up.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.contract ?? "")) throw new Error("VRF contract address is not configured.");
  return cfg;
}

function chainFor(cfg: VrfConfig) {
  return defineChain({
    id: cfg.chain_id,
    name: cfg.chain ?? `chain-${cfg.chain_id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc_url] } },
  });
}

export function vrfPublic(cfg: VrfConfig) {
  return createPublicClient({ chain: chainFor(cfg), transport: http(cfg.rpc_url) });
}

function vrfWallet(cfg: VrfConfig) {
  const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("VRF operator key is not configured on the server.");
  const account = privateKeyToAccount(key as Hex);
  return { account, wallet: createWalletClient({ account, chain: chainFor(cfg), transport: http(cfg.rpc_url) }) };
}

export function txUrl(cfg: VrfConfig, hash?: string | null) {
  return hash && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${hash}` : undefined;
}

/**
 * Send requestSpins. Throws `BeforeBroadcastError` if the tx never left the server
 * (safe to refund); any later failure leaves spins pending for the settle step.
 */
export class BeforeBroadcastError extends Error {}

export async function requestSpinsOnChain(cfg: VrfConfig, spinIds: string[]) {
  const pub = vrfPublic(cfg);
  let hash: Hex;
  let requestId: bigint;
  try {
    const { account, wallet } = vrfWallet(cfg);
    const sim = await pub.simulateContract({
      account,
      address: cfg.contract as Hex,
      abi: gotchaVrfAbi,
      functionName: "requestSpins",
      args: [spinIds.map(uuidToBytes32)],
    });
    requestId = sim.result;
    hash = await wallet.writeContract(sim.request);
  } catch (e) {
    throw new BeforeBroadcastError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
  }
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 40_000 });
    if (receipt.status !== "success") return { hash, requestId, reverted: true as const };
  } catch {
    /* slow inclusion — settle step will pick it up */
  }
  return { hash, requestId, reverted: false as const };
}

export async function readSpins(cfg: VrfConfig, spinIds: string[]) {
  const pub = vrfPublic(cfg);
  const rows = await pub.readContract({
    address: cfg.contract as Hex,
    abi: gotchaVrfAbi,
    functionName: "getSpins",
    args: [spinIds.map(uuidToBytes32)],
  });
  return rows.map((r, i) => ({
    id: spinIds[i]!,
    status: Number(r.status),
    prizeIndex: Number(r.prizeIndex),
    requestId: r.requestId,
    randomWord: r.randomWord,
  }));
}

export async function readPool(cfg: VrfConfig) {
  const pub = vrfPublic(cfg);
  const [pool, version, pending] = await Promise.all([
    pub.readContract({ address: cfg.contract as Hex, abi: gotchaVrfAbi, functionName: "getPool" }),
    pub.readContract({ address: cfg.contract as Hex, abi: gotchaVrfAbi, functionName: "poolVersion" }),
    pub.readContract({ address: cfg.contract as Hex, abi: gotchaVrfAbi, functionName: "pendingRequests" }),
  ]);
  return { pool: pool.map((p) => ({ weight: Number(p.weight), remaining: Number(p.remaining) })), version: Number(version), pending: Number(pending) };
}

export async function publishPoolOnChain(cfg: VrfConfig, weights: number[], remaining: number[]) {
  const pub = vrfPublic(cfg);
  const { account, wallet } = vrfWallet(cfg);
  const sim = await pub.simulateContract({
    account,
    address: cfg.contract as Hex,
    abi: gotchaVrfAbi,
    functionName: "setPool",
    args: [weights, remaining],
  });
  const hash = await wallet.writeContract(sim.request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("setPool transaction reverted");
  return hash;
}

type PrizeRow = { id: string; weight: number; inventory: number | null; active: boolean; onchain_index: number | null };

/** Arrays exactly as the contract should hold them, indexed by onchain_index. */
export function poolArrays(prizes: PrizeRow[]) {
  const indexed = prizes.filter((p) => p.onchain_index != null);
  const n = indexed.length ? Math.max(...indexed.map((p) => p.onchain_index!)) + 1 : 0;
  const weights = Array<number>(n).fill(0);
  const remaining = Array<number>(n).fill(0);
  for (const p of indexed) {
    const i = p.onchain_index!;
    weights[i] = p.active ? Math.max(0, Math.min(p.weight, UNLIMITED)) : 0;
    remaining[i] = p.inventory == null ? UNLIMITED : Math.max(0, Math.min(p.inventory, UNLIMITED - 1));
  }
  return { weights, remaining };
}

/**
 * True when the odds the app shows are the odds the contract will use.
 * Inventory is compared separately: the contract decrements it the moment Chainlink answers,
 * the database only when the spin is settled, so they can differ briefly.
 */
export function weightsMatch(a: { weights: number[] }, chain: { weight: number }[]) {
  return a.weights.length === chain.length && chain.every((c, i) => c.weight === a.weights[i]);
}
