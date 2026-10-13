// Stock certificate NFTs on their own chain (Robinhood Chain for StonkBrokers). Server only.
// The project's custody wallet holds the certificate NFTs; its private key is the STOCK_SENDER_PRIVATE_KEY secret
// (set in Lovable → Secrets, never shown anywhere). Sending the NFT sends everything in its token-bound wallet.
// An optional private RPC can be set as the STOCK_RPC_URL secret; otherwise the RPC from Admin → Stock certificates.
import { createPublicClient, createWalletClient, getAddress, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainDef, resilientTransport } from "./rpc.server";

export type StockConfig = {
  chain_id: number | null;
  chain_name: string | null;
  rpc_url: string | null;
  explorer_url: string | null;
  contract: string | null;
};

const ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function name() view returns (string)",
]);
const RPC = { privateEnv: "STOCK_RPC_URL" };

/** The custody account, or null when the secret isn't set (or isn't a private key). */
export function custodyAccount() {
  const raw = process.env["STOCK_SENDER_PRIVATE_KEY"]?.trim();
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return null;
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

/** What's still missing before certificates can be sent (empty = ready). */
export function stockMissing(cfg: StockConfig) {
  const m: string[] = [];
  if (!cfg.chain_id) m.push("chain ID");
  if (!cfg.contract) m.push("certificate contract");
  if (!cfg.rpc_url && !process.env["STOCK_RPC_URL"]) m.push("RPC URL");
  if (!custodyAccount()) m.push("STOCK_SENDER_PRIVATE_KEY secret");
  return m;
}

function chain(cfg: StockConfig) {
  if (!cfg.chain_id) throw new Error("Stock certificates have no chain set yet.");
  return chainDef(cfg.chain_id, cfg.chain_name ?? undefined, cfg.rpc_url, RPC);
}
function reader(cfg: StockConfig) {
  return createPublicClient({ chain: chain(cfg), transport: resilientTransport(cfg.chain_id!, cfg.rpc_url, RPC) });
}

export function explorerTx(cfg: StockConfig, hash: string | null) {
  return hash && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/tx/${hash}` : null;
}
export function explorerToken(cfg: StockConfig, contract: string | null, tokenId: string | null) {
  return contract && tokenId && cfg.explorer_url ? `${cfg.explorer_url.replace(/\/$/, "")}/token/${contract}/instance/${tokenId}` : null;
}

/** Current owner of a certificate (lower case), or null if it doesn't exist / can't be read. */
export async function ownerOf(cfg: StockConfig, contract: string, tokenId: string) {
  const owner = await reader(cfg).readContract({
    address: getAddress(contract),
    abi: ABI,
    functionName: "ownerOf",
    args: [BigInt(tokenId)],
  });
  return String(owner).toLowerCase();
}

/** Custody wallet overview for the admin tab: address, gas balance (wei) and who owns each listed token. */
export async function custodyStatus(cfg: StockConfig, tokenIds: string[]) {
  const acct = custodyAccount();
  const out: {
    address: string | null;
    gasWei: string | null;
    collection: string | null;
    owners: Record<string, string | null>;
    error: string | null;
  } = { address: acct?.address.toLowerCase() ?? null, gasWei: null, collection: null, owners: {}, error: null };
  if (!cfg.chain_id) return out;
  try {
    const c = reader(cfg);
    const [bal, name] = await Promise.all([
      acct ? c.getBalance({ address: acct.address }) : Promise.resolve(null),
      cfg.contract ? c.readContract({ address: getAddress(cfg.contract), abi: ABI, functionName: "name" }).catch(() => null) : Promise.resolve(null),
    ]);
    out.gasWei = bal == null ? null : bal.toString();
    out.collection = name ?? null;
    if (cfg.contract) {
      const ids = tokenIds.slice(0, 300);
      const owners = await Promise.all(ids.map((id) => ownerOf(cfg, cfg.contract!, id).catch(() => null)));
      ids.forEach((id, i) => (out.owners[id] = owners[i] ?? null));
    }
  } catch (e) {
    const { chainErrorMessage } = await import("./rpc.server");
    out.error = chainErrorMessage(e, "read the stock certificate chain");
  }
  return out;
}

/** Sends one certificate NFT from the custody wallet (checked first with a simulation). Returns the tx hash. */
export async function sendCertificate(cfg: StockConfig, contract: string, tokenId: string, to: string) {
  const acct = custodyAccount();
  if (!acct) throw new Error("The custody wallet's key (STOCK_SENDER_PRIVATE_KEY) isn't set.");
  const c = reader(cfg);
  const { request } = await c.simulateContract({
    account: acct,
    address: getAddress(contract),
    abi: ABI,
    functionName: "safeTransferFrom",
    args: [acct.address, getAddress(to), BigInt(tokenId)],
  });
  const w = createWalletClient({ account: acct, chain: chain(cfg), transport: resilientTransport(cfg.chain_id!, cfg.rpc_url, RPC) });
  return w.writeContract(request);
}

/** Waits up to `ms` for the transfer: "ok", "reverted", or "pending" (not confirmed yet; look again later). */
export async function transferState(cfg: StockConfig, hash: string, ms = 0): Promise<"ok" | "reverted" | "pending"> {
  const c = reader(cfg);
  try {
    const r = ms
      ? await c.waitForTransactionReceipt({ hash: hash as Hex, timeout: ms, pollingInterval: 1000 })
      : await c.getTransactionReceipt({ hash: hash as Hex });
    return r.status === "success" ? "ok" : "reverted";
  } catch {
    return "pending";
  }
}
