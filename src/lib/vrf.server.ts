// Server-only helpers for the GotchaVRF contract (Chainlink VRF v2.5).
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
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
  /** Confirmations before a request (or a fulfilment read) counts as canonical. */
  min_confirmations?: number;
  /** RPC URLs for chains that still have unsettled spins after the config moved elsewhere. */
  rpc_by_chain?: Record<string, string>;
  /** Alert threshold for the VRF subscription balance, in the subscription's token (wei units, as a string). */
  min_subscription_balance?: string;
};

export const UNLIMITED = 0xffffffff;
export const NO_PRIZE = 255;
/** Mirrors GotchaVRF.Status (3 = Cancelled existed only on old deployments). */
export const ChainStatus = { None: 0, Pending: 1, Fulfilled: 2, LegacyCancelled: 3 } as const;

export function uuidToBytes32(id: string): Hex {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Bad spin id: ${id}`);
  return `0x${hex.padStart(64, "0")}`;
}

export function bytes32ToUuid(b: Hex): string {
  const hex = b.toLowerCase().replace(/^0x/, "").slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isAddress(a: unknown): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export function requireVrf(cfg: VrfConfig | null | undefined): VrfConfig {
  if (!cfg?.enabled)
    throw new Error("Spins are paused while the Chainlink VRF draw is being set up.");
  if (!isAddress(cfg.contract)) throw new Error("VRF contract address is not configured.");
  return cfg;
}

export function chainFor(chainId: number, rpcUrl: string, name?: string) {
  return defineChain({
    id: chainId,
    name: name ?? `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** RPC for a captured chain id: the current config if it matches, else rpc_by_chain. */
export function rpcFor(cfg: VrfConfig, chainId: number): string | null {
  if (cfg.chain_id === chainId && cfg.rpc_url) return cfg.rpc_url;
  return cfg.rpc_by_chain?.[String(chainId)] ?? null;
}

export function vrfPublic(cfg: VrfConfig, chainId = cfg.chain_id): PublicClient {
  const url = rpcFor(cfg, chainId);
  if (!url) throw new Error(`No RPC configured for chain ${chainId} (vrf.rpc_by_chain)`);
  return createPublicClient({
    chain: chainFor(chainId, url, cfg.chain),
    transport: http(url),
    cacheTime: 0,
  }) as PublicClient;
}

export function operatorAccount(): LocalAccount {
  const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("VRF operator key is not configured on the server.");
  return privateKeyToAccount(key as Hex);
}

export function operatorWallet(cfg: VrfConfig) {
  const account = operatorAccount();
  return {
    account,
    wallet: createWalletClient({
      account,
      chain: chainFor(cfg.chain_id, cfg.rpc_url, cfg.chain),
      transport: http(cfg.rpc_url),
    }),
  };
}

export function txUrl(cfg: VrfConfig, hash?: string | null) {
  return hash && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${hash}` : undefined;
}

export async function readSpins(
  pub: PublicClient,
  contract: string,
  spinIds: string[],
  blockNumber?: bigint,
) {
  const rows = await pub.readContract({
    address: contract as Hex,
    abi: gotchaVrfAbi,
    functionName: "getSpins",
    args: [spinIds.map(uuidToBytes32)],
    ...(blockNumber != null ? { blockNumber } : {}),
  });
  return rows.map((r, i) => ({
    id: spinIds[i]!,
    status: Number(r.status),
    prizeIndex: Number(r.prizeIndex),
    requestId: r.requestId,
    randomWord: r.randomWord,
  }));
}

export async function readPool(pub: PublicClient, contract: string) {
  const address = contract as Hex;
  const [pool, version, pending, paused] = await Promise.all([
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "getPool" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "poolVersion" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "pendingRequests" }),
    pub
      .readContract({ address, abi: gotchaVrfAbi, functionName: "requestsPaused" })
      .catch(() => false),
  ]);
  return {
    weights: pool.map((p) => BigInt(p.weight)),
    remaining: pool.map((p) => BigInt(p.remaining)),
    version: Number(version),
    pending: Number(pending),
    paused: Boolean(paused),
  };
}

const coordinatorAbi = parseAbi([
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
]);

/** VRF subscription funding as seen on-chain (null fields when it can't be read). */
export async function readSubscription(pub: PublicClient, contract: string) {
  const address = contract as Hex;
  const [coordinator, subId, native] = await Promise.all([
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "s_vrfCoordinator" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "subscriptionId" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "nativePayment" }),
  ]);
  const [balance, nativeBalance, , , consumers] = await pub.readContract({
    address: coordinator,
    abi: coordinatorAbi,
    functionName: "getSubscription",
    args: [subId],
  });
  return {
    coordinator,
    subId: subId.toString(),
    nativePayment: native,
    balance: (native ? nativeBalance : balance).toString(),
    isConsumer: consumers.some((c) => c.toLowerCase() === contract.toLowerCase()),
  };
}

/** Send setPool from the operator and return the transaction hash (confirmation is read back from the contract). */
export async function sendSetPool(cfg: VrfConfig, weights: bigint[], remaining: bigint[]) {
  const pub = vrfPublic(cfg);
  const { account, wallet } = operatorWallet(cfg);
  const sim = await pub.simulateContract({
    account,
    address: cfg.contract as Hex,
    abi: gotchaVrfAbi,
    functionName: "setPool",
    args: [weights.map(Number), remaining.map(Number)],
  });
  return wallet.writeContract(sim.request);
}
