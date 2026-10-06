// Server-only: verify APE payments for spin purchases on ApeChain.
import { createPublicClient, defineChain, formatEther, http, parseEther, type Hex } from "viem";

export type PurchaseConfig = {
  enabled: boolean;
  chain_id: number;
  rpc_url: string;
  explorer_url?: string;
  treasury: string;
  price_ape_per_spin: string;
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

/** The purchase id the wallet sends as calldata (binds the payment to this purchase). */
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

/** Check that `txHash` is a confirmed payment of `priceWei` APE to the treasury carrying this purchase id. */
export async function checkPayment(cfg: PurchaseConfig, txHash: Hex, purchaseId: string, priceWei: bigint): Promise<PaymentCheck> {
  const pub = client(cfg);
  let tx;
  try {
    tx = await pub.getTransaction({ hash: txHash });
  } catch {
    return { state: "pending" }; // not visible on the RPC yet
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
