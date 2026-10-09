// Server-only helpers for the GotchaVRF contract (Chainlink VRF v2.5).
//
// Submission model (see supabase/migrations/20261009100200_economics_draws.sql):
//   1. sign the request transaction locally with an explicit nonce, gas and fees;
//   2. persist the exact signed bytes + hash + nonce BEFORE broadcasting;
//   3. broadcast; any error after this point is ambiguous (the node may have the tx);
//   4. reconcile from the chain: canonical receipt -> confirmed/reverted; our hash unknown and the
//      nonce consumed by a different tx at a safe depth -> dropped; otherwise re-send the SAME bytes.
// The requestId always comes from the confirmed receipt's SpinRequested events, never a simulation.
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gotchaVrfAbi } from "./gotchaVrfAbi";

export type VrfConfig = {
  enabled: boolean;
  chain?: string;
  chain_id: number;
  rpc_url: string;
  contract: string;
  coordinator?: string;
  explorer_url?: string;
  max_batch?: number;
  min_confirmations?: number;
  min_subscription_balance?: string;
};

export const UNLIMITED = 0xffffffff;
export const NO_PRIZE = 255;
/** Mirrors GotchaVRF.Status (no Cancelled state any more). */
export const ChainStatus = { None: 0, Pending: 1, Fulfilled: 2 } as const;

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export function uuidToBytes32(id: string): Hex {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Bad spin id: ${id}`);
  return `0x${hex.padStart(64, "0")}`;
}

export function bytes32ToUuid(b: string): string {
  const hex = b.toLowerCase().replace(/^0x/, "").slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Why draws can't run right now (null = ready). Purely configuration; chain checks happen separately. */
export function vrfConfigProblem(cfg: Partial<VrfConfig> | null | undefined): string | null {
  if (!cfg?.enabled) return "Real draws are switched off while the Chainlink draw is being set up.";
  if (!isAddr(cfg.contract)) return "The draw contract address isn't configured yet.";
  if (!cfg.rpc_url || !cfg.chain_id) return "The draw chain isn't configured yet.";
  return null;
}

export function requireVrf(cfg: VrfConfig | null | undefined): VrfConfig {
  const p = vrfConfigProblem(cfg);
  if (p) throw new Error(p);
  return cfg!;
}

function chainFor(cfg: VrfConfig) {
  return defineChain({
    id: cfg.chain_id,
    name: cfg.chain ?? `chain-${cfg.chain_id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc_url] } },
  });
}

export function vrfPublic(cfg: VrfConfig): PublicClient {
  return createPublicClient({ chain: chainFor(cfg), transport: http(cfg.rpc_url, { timeout: 15_000 }) }) as PublicClient;
}

export function operatorAccount() {
  const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("VRF operator key is not configured on the server.");
  return privateKeyToAccount(key as Hex);
}

export function txUrl(cfg: Pick<VrfConfig, "explorer_url">, hash?: string | null) {
  return hash && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${hash}` : undefined;
}

export const minConfirmations = (cfg: VrfConfig) => Math.max(1, Number(cfg.min_confirmations ?? 3));

// ---------------------------------------------------------------- pool & health

export async function readPool(cfg: VrfConfig, pub = vrfPublic(cfg)) {
  const address = cfg.contract as Hex;
  const [pool, version, pending] = await Promise.all([
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "getPool" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "poolVersion" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "pendingRequests" }),
  ]);
  let paused = false;
  try {
    paused = await pub.readContract({ address, abi: gotchaVrfAbi, functionName: "requestsPaused" });
  } catch {
    // Pre-replacement contracts have no pause flag (and still carry cancelRequest) — see contracts/README.md.
    paused = false;
  }
  return {
    pool: pool.map((p) => ({ weight: Number(p.weight), remaining: Number(p.remaining) })),
    version: BigInt(version),
    pending: Number(pending),
    paused,
  };
}

const coordinatorAbi = parseAbi([
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
]);

/** Coordinator address, subscription balances and consumer registration, for monitoring. */
export async function readVrfHealth(cfg: VrfConfig, pub = vrfPublic(cfg)) {
  const address = cfg.contract as Hex;
  const [coordinator, subId, nativePayment] = await Promise.all([
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "s_vrfCoordinator" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "subscriptionId" }),
    pub.readContract({ address, abi: gotchaVrfAbi, functionName: "nativePayment" }),
  ]);
  const [balance, nativeBalance, , , consumers] = await pub.readContract({
    address: coordinator as Hex,
    abi: coordinatorAbi,
    functionName: "getSubscription",
    args: [subId],
  });
  return {
    coordinator: (coordinator as string).toLowerCase(),
    subscriptionId: subId.toString(),
    nativePayment,
    balance: balance.toString(),
    nativeBalance: nativeBalance.toString(),
    isConsumer: consumers.map((c) => c.toLowerCase()).includes(cfg.contract.toLowerCase()),
  };
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

/** True when the odds the app shows are the odds the contract will use. */
export function weightsMatch(a: { weights: number[] }, chain: { weight: number }[]) {
  return a.weights.length === chain.length && chain.every((c, i) => c.weight === a.weights[i]);
}

// ---------------------------------------------------------------- signing & broadcast

export type SignedRequest = { from: string; nonce: number; hash: Hex; serialized: Hex };

/**
 * Builds and signs requestSpins locally. Throws on any problem BEFORE a signature exists (so the
 * caller may refund). Gas estimation doubles as a revert pre-check; its output is never used for ids.
 */
export async function signRequest(cfg: VrfConfig, spinIds: string[], pub = vrfPublic(cfg)): Promise<SignedRequest> {
  const account = operatorAccount();
  const chainId = await pub.getChainId();
  if (chainId !== cfg.chain_id) throw new Error(`RPC is on chain ${chainId}, expected ${cfg.chain_id}`);
  const data = encodeFunctionData({ abi: gotchaVrfAbi, functionName: "requestSpins", args: [spinIds.map(uuidToBytes32)] });
  const to = cfg.contract as Hex;
  const [nonce, gasEstimate, fees] = await Promise.all([
    pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
    pub.estimateGas({ account: account.address, to, data }),
    pub.estimateFeesPerGas(),
  ]);
  const serialized = await account.signTransaction({
    chainId: cfg.chain_id,
    type: "eip1559",
    to,
    data,
    nonce,
    gas: (gasEstimate * 13n) / 10n,
    maxFeePerGas: (fees.maxFeePerGas! * 2n),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
    value: 0n,
  });
  return { from: account.address.toLowerCase(), nonce, hash: keccak256(serialized), serialized };
}

/** Sends the exact signed bytes. Never throws; returns the error text if the node complained. */
export async function broadcastRaw(cfg: VrfConfig, serialized: Hex, pub = vrfPublic(cfg)): Promise<{ error: string | null }> {
  try {
    await pub.sendRawTransaction({ serializedTransaction: serialized });
    return { error: null };
  } catch (e) {
    const msg = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? "broadcast failed").slice(0, 300);
    // The node already has exactly this transaction: that's a successful (re)broadcast.
    if (/already known|known transaction|already imported/i.test(msg)) return { error: null };
    return { error: msg };
  }
}

// ---------------------------------------------------------------- reconciliation

export type SubmissionState =
  | { state: "pending"; reason: string }
  | { state: "not_found" }
  | { state: "confirmed"; requestId: bigint; spinIds: string[]; blockNumber: bigint; blockHash: Hex; blockTime: Date; confirmations: number }
  | { state: "reverted"; blockNumber: bigint; blockHash: Hex }
  | { state: "dropped"; evidence: Record<string, string> }
  | { state: "conflict"; evidence: Record<string, string> };

/** What the chain says about one submission, judged only at a safe confirmation depth. */
export async function checkSubmission(
  cfg: VrfConfig,
  sub: { tx_hash: string; from_address: string; nonce: number | string },
  pub = vrfPublic(cfg),
): Promise<SubmissionState> {
  const need = minConfirmations(cfg);
  const hash = sub.tx_hash as Hex;
  const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
  const head = await pub.getBlockNumber();
  if (receipt) {
    const confirmations = Number(head - receipt.blockNumber + 1n);
    if (confirmations < need) return { state: "pending", reason: `${confirmations}/${need} confirmations` };
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return { state: "pending", reason: "receipt block is not canonical yet (reorg?)" };
    if (receipt.status !== "success") return { state: "reverted", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    const spinIds: string[] = [];
    const requestIds = new Set<bigint>();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== cfg.contract.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: gotchaVrfAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "SpinRequested") {
          const args = ev.args as { spinId: Hex; requestId: bigint };
          spinIds.push(bytes32ToUuid(args.spinId));
          requestIds.add(args.requestId);
        }
      } catch {
        /* other events */
      }
    }
    if (requestIds.size !== 1 || !spinIds.length) {
      return { state: "conflict", evidence: { reason: "receipt has no single SpinRequested request id", tx: hash } };
    }
    return {
      state: "confirmed",
      requestId: [...requestIds][0]!,
      spinIds,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTime: new Date(Number(block.timestamp) * 1000),
      confirmations,
    };
  }
  const tx = await pub.getTransaction({ hash }).catch(() => null);
  if (tx) return { state: "pending", reason: tx.blockNumber == null ? "in mempool" : "mined, receipt not available yet" };
  // Our hash is unknown. If the nonce was consumed at a safe depth, a different transaction used it:
  // ours can never be included any more, so no randomness was requested.
  const safeBlock = head > BigInt(need) ? head - BigInt(need) : 0n;
  const usedAtSafeDepth = await pub.getTransactionCount({ address: sub.from_address as Hex, blockNumber: safeBlock });
  if (usedAtSafeDepth > Number(sub.nonce)) {
    return { state: "dropped", evidence: { nonce: String(sub.nonce), nonce_used_through: String(usedAtSafeDepth), checked_at_block: safeBlock.toString() } };
  }
  return { state: "not_found" };
}

/** Chain results for spins, read at a block `min_confirmations` deep (canonical). */
export async function readSpinsAtSafeBlock(cfg: VrfConfig, spinIds: string[], pub = vrfPublic(cfg)) {
  const head = await pub.getBlockNumber();
  const need = BigInt(minConfirmations(cfg));
  const blockNumber = head > need ? head - need : head;
  const block = await pub.getBlock({ blockNumber });
  const rows = await pub.readContract({
    address: cfg.contract as Hex,
    abi: gotchaVrfAbi,
    functionName: "getSpins",
    args: [spinIds.map(uuidToBytes32)],
    blockNumber,
  });
  return {
    blockNumber,
    blockHash: block.hash!,
    spins: rows.map((r, i) => ({
      id: spinIds[i]!,
      status: Number(r.status),
      prizeIndex: Number(r.prizeIndex),
      requestId: r.requestId,
      randomWord: r.randomWord,
    })),
  };
}

/** Signs and sends setPool (admin-triggered, coordinated through begin_pool_publication). */
export async function publishPoolOnChain(cfg: VrfConfig, weights: number[], remaining: number[], pub = vrfPublic(cfg)) {
  const account = operatorAccount();
  const chainId = await pub.getChainId();
  if (chainId !== cfg.chain_id) throw new Error(`RPC is on chain ${chainId}, expected ${cfg.chain_id}`);
  const data = encodeFunctionData({ abi: gotchaVrfAbi, functionName: "setPool", args: [weights, remaining] });
  const to = cfg.contract as Hex;
  const [nonce, gas, fees] = await Promise.all([
    pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
    pub.estimateGas({ account: account.address, to, data }),
    pub.estimateFeesPerGas(),
  ]);
  const serialized = await account.signTransaction({
    chainId: cfg.chain_id, type: "eip1559", to, data, nonce, gas: (gas * 13n) / 10n,
    maxFeePerGas: fees.maxFeePerGas! * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!, value: 0n,
  });
  const hash = await pub.sendRawTransaction({ serializedTransaction: serialized });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000, confirmations: minConfirmations(cfg) });
  if (receipt.status !== "success") throw new Error("setPool transaction reverted");
  const version = await pub.readContract({ address: to, abi: gotchaVrfAbi, functionName: "poolVersion" });
  return { hash, version: BigInt(version) };
}
