import { createPublicClient, defineChain, formatEther, http, parseEther, type Hex } from "viem";

export type PurchaseConfig = {
  enabled: boolean;
  chain_id: number;
  rpc_url: string;
  explorer_url?: string;
  treasury: string;
  price_ape_per_spin: string;
  price_usd_per_spin?: string;
  price_source?: "fixed" | "coinbase_spot" | "chainlink_ethereum";
  price_feed_address?: string;
  price_feed_rpc?: string;
  bundles?: number[];
  min_confirmations?: number;
  privy_app_id?: string;
};

export const DEFAULT_BUNDLES = [5, 10, 15, 20];

export function requirePurchasing(cfg: PurchaseConfig | null | undefined): PurchaseConfig {
  if (!cfg?.enabled) throw new Error("Spin purchases aren't open yet.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.treasury ?? "")) throw new Error("The treasury wallet isn't configured yet.");
  return cfg;
}

/** Total price in wei for a bundle. */
export function bundlePriceWei(cfg: PurchaseConfig, quantity: number) {
  const each = parseEther(String(cfg.price_ape_per_spin || "0"));
  if (each <= 0n) throw new Error("The spin price isn't configured yet.");
  return each * BigInt(quantity);
}

/** Fetch a fresh exchange quote; never silently substitute a fixed APE price. */
export async function quoteSpinPrice(cfg: PurchaseConfig) {
  if (!cfg.price_usd_per_spin || cfg.price_source === "fixed" || !cfg.price_source) {
    return { eachWei: bundlePriceWei(cfg, 1).toString(), quotedAt: new Date().toISOString() };
  }

  let usdRate: bigint;
  if (cfg.price_source === "coinbase_spot") {
    const response = await fetch("https://api.coinbase.com/v2/prices/APE-USD/spot", { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error("Live APE pricing is unavailable. Please try again.");
    const body = await response.json() as { data?: { amount?: string; base?: string; currency?: string } };
    const rate = body.data;
    if (rate?.base !== "APE" || rate.currency !== "USD" || !/^\d+(\.\d{1,18})?$/.test(rate.amount ?? "")) throw new Error("Live APE pricing is unavailable. Please try again.");
    usdRate = parseEther(rate.amount ?? "0");
  } else if (cfg.price_source === "chainlink_ethereum") {
    const feed = cfg.price_feed_address || "0xd10abbc76679a20055e167bb80a24ac851b37056";
    const rpc = cfg.price_feed_rpc || "https://ethereum-rpc.publicnode.com";
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: feed, data: "0xfeaf968c" }, "latest"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Chainlink price feed is unavailable.");
    const body = await response.json();
    if (body.error || !body.result || body.result === "0x") throw new Error("Failed to read Chainlink price feed.");
    
    // latestRoundData returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    // answer is at offset 32 (length 32)
    const answerHex = "0x" + body.result.slice(66, 130);
    const updatedAtHex = "0x" + body.result.slice(194, 258);
    usdRate = BigInt(answerHex);
    const updatedAt = Number(BigInt(updatedAtHex));
    const now = Math.floor(Date.now() / 1000);
    
    // Heartbeat check: APE/USD on Eth is 1h/2%. We allow 24h to be safe but typically it's much fresher.
    if (now - updatedAt > 86400) throw new Error("Chainlink price feed is stale.");
    if (usdRate <= 0n) throw new Error("Invalid price from Chainlink feed.");
    
    // Chainlink USD feeds have 8 decimals. We need to normalize to 18 for the calculation below.
    const usdPrice = parseEther(cfg.price_usd_per_spin!);
    const eachWei = (usdPrice * 10n ** 8n) / usdRate;
    return { eachWei: eachWei.toString(), quotedAt: new Date(updatedAt * 1000).toISOString() };
  } else {
    throw new Error(`Unsupported price source: ${cfg.price_source}`);
  }

  const usdPrice = parseEther(cfg.price_usd_per_spin);
  if (usdRate <= 0n || usdPrice <= 0n) throw new Error("Invalid APE/USD price.");
  const eachWei = (usdPrice * 10n ** 18n + usdRate - 1n) / usdRate;
  return { eachWei: eachWei.toString(), quotedAt: new Date().toISOString() };
}

export function purchaseData(purchaseId: string): Hex {
  const hex = purchaseId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Bad purchase id");
  return `0x${hex}`;
}

function client(cfg: PurchaseConfig) {
  const chain = defineChain({
    id: cfg.chain_id,
    name: "ApeChain",
    nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc_url] } },
  });
  return createPublicClient({ chain, transport: http(cfg.rpc_url) });
}

export type PaymentCheck =
  | { state: "pending" }
  | { state: "ok"; payer: string }
  | { state: "invalid"; reason: string };

export async function checkPayment(cfg: PurchaseConfig, txHash: Hex, purchaseId: string, priceWei: bigint): Promise<PaymentCheck> {
  const pub = client(cfg);
  let tx;
  try {
    tx = await pub.getTransaction({ hash: txHash });
  } catch {
    return { state: "pending" };
  }
  if (tx.chainId != null && tx.chainId !== cfg.chain_id) return { state: "invalid", reason: "That transaction is on a different network." };
  if (!tx.to || tx.to.toLowerCase() !== cfg.treasury.toLowerCase()) return { state: "invalid", reason: "That transaction wasn't sent to the ApeGames treasury." };
  if ((tx.input ?? "0x").toLowerCase() !== purchaseData(purchaseId)) return { state: "invalid", reason: "That transaction belongs to a different purchase." };
  if (tx.value < priceWei) return { state: "invalid", reason: `Payment was ${formatEther(tx.value)} APE; ${formatEther(priceWei)} APE is required.` };
  if (tx.blockNumber == null) return { state: "pending" };

  const receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) return { state: "pending" };
  if (receipt.status !== "success") return { state: "invalid", reason: "That transaction failed on-chain." };
  const head = await pub.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(cfg.min_confirmations ?? 1)) return { state: "pending" };
  return { state: "ok", payer: tx.from };
}
