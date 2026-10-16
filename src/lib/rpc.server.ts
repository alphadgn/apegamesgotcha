// Resilient blockchain connections for the server. Free public RPCs (e.g. https://mainnet.base.org) answer
// "429 Too Many Requests" when busy, which made live draws fail. Every server-side chain call goes through:
//   1. a private RPC from the VRF_RPC_URL / APECHAIN_RPC_URL secret when set (recommended: Alchemy, QuickNode…),
//   2. the RPC in the admin configuration,
//   3. a few well-known public RPCs for the same chain,
// with JSON-RPC batching (fewer requests) and patient retries with back-off on 429 / 5xx.
import { defineChain, fallback, http, type Chain, type Transport } from "viem";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const; // same address on Base, Base Sepolia and ApeChain

/** Public RPCs per chain id, tried after the configured one. */
const PUBLIC_RPCS: Record<number, string[]> = {
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth", "https://eth.drpc.org"],
  8453: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
    "https://base.drpc.org",
  ],
  84532: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
  33139: ["https://rpc.apechain.com/http", "https://apechain.drpc.org"],
  33111: ["https://rpc.curtis.apechain.com"],
};

/** Chains with Multicall3 deployed at MULTICALL3 (lets several reads go out as one call). */
const MULTICALL_CHAINS = new Set([1, 8453, 84532, 33139]);

/** Chains whose native coin is APE (everything else here pays gas in ETH). */
const APE_CHAINS = new Set([33139, 33111]);

/** Which secret holds a private RPC (another chain, e.g. the stock certificates' chain, names its own). */
export type RpcOptions = { privateEnv?: string };

function privateRpc(chainId: number, opts?: RpcOptions) {
  const name = opts?.privateEnv ?? (APE_CHAINS.has(chainId) ? "APECHAIN_RPC_URL" : chainId === 1 ? "ETH_RPC_URL" : "VRF_RPC_URL");
  const env = process.env[name];
  return env && /^https?:\/\//.test(env) ? env : undefined;
}

/** The RPC list for a chain, best first, without duplicates. */
export function rpcUrls(chainId: number, configured?: string | null, opts?: RpcOptions) {
  const urls = [
    privateRpc(chainId, opts),
    configured || undefined,
    ...(PUBLIC_RPCS[chainId] ?? []),
  ].filter((u): u is string => !!u);
  return [...new Set(urls.map((u) => u.trim()))];
}

/** One transport that batches requests, retries busy RPCs with back-off and falls over to the next RPC. */
export function resilientTransport(chainId: number, configured?: string | null, opts?: RpcOptions): Transport {
  const urls = rpcUrls(chainId, configured, opts);
  const one = (url: string, first: boolean) =>
    http(url, {
      batch: { wait: 16 }, // calls made together go out as one HTTP request
      // The first RPC gets patient retries (0.7s, 1.4s, 2.8s: viem backs off on 429 / 5xx); backups one quick retry.
      retryCount: first ? 3 : 1,
      retryDelay: 700,
      timeout: first ? 10_000 : 6_000,
    });
  if (urls.length === 1) return one(urls[0]!, true);
  return fallback(
    urls.map((u, i) => one(u, i === 0)),
    { retryCount: 0 }, // each RPC already retried; then the next one
  );
}

/** A viem chain definition for the configured network, with Multicall3 so reads can be combined. */
export function chainDef(
  chainId: number,
  name: string | undefined,
  configured?: string | null,
  opts?: RpcOptions,
): Chain {
  const ape = APE_CHAINS.has(chainId);
  return defineChain({
    id: chainId,
    name: name ?? (ape ? "ApeChain" : `chain-${chainId}`),
    nativeCurrency: ape
      ? { name: "ApeCoin", symbol: "APE", decimals: 18 }
      : { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls(chainId, configured, opts) } },
    ...(MULTICALL_CHAINS.has(chainId)
      ? { contracts: { multicall3: { address: MULTICALL3 } } }
      : {}),
  });
}

/**
 * True when a chain error means the RPCs were busy or unreachable (rate limited, timed out, connection failed)
 * rather than a real on-chain failure such as a revert.
 */
export function isRpcBusy(e: unknown): boolean {
  type E = {
    name?: string;
    status?: number;
    shortMessage?: string;
    message?: string;
    details?: string;
    cause?: unknown;
  };
  for (let x = e as E | undefined, i = 0; x && i < 8; x = x.cause as E | undefined, i++) {
    if (x.status === 429 || (x.status ?? 0) >= 500) return true;
    if (
      x.name === "HttpRequestError" ||
      x.name === "TimeoutError" ||
      x.name === "WebSocketRequestError"
    )
      return true;
    const text = `${x.shortMessage ?? ""} ${x.message ?? ""} ${x.details ?? ""}`;
    if (/\b429\b|too many requests|rate limit/i.test(text)) return true;
  }
  return false;
}

/** A short, player-friendly message for a failed chain call (never the raw request dump). */
export function chainErrorMessage(e: unknown, action = "reach the blockchain") {
  if (isRpcBusy(e))
    return `The blockchain network is busy right now, so we couldn't ${action}. Your spins are safe; try again in a few seconds.`;
  const short =
    (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? "Unknown error";
  return `Couldn't ${action}: ${short.split("\n")[0]!.slice(0, 160)}`;
}
