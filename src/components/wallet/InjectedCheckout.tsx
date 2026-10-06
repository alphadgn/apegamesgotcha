// Fallback used until a Privy App ID is configured: any browser-extension wallet (MetaMask, Rabby, Coinbase…).
import { useCallback, useEffect, useState } from "react";
import { toHex, type Hex } from "viem";
import { CheckoutPanel, type PurchaseSettings, type WalletAdapter } from "./CheckoutPanel";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (x: unknown) => void) => void; removeListener?: (e: string, f: (x: unknown) => void) => void };

const eth = () => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum);

async function switchToApeChain(provider: Eip1193, s: PurchaseSettings) {
  const chainId = toHex(s.chain_id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: "ApeChain", nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 }, rpcUrls: [s.rpc_url], blockExplorerUrls: s.explorer_url ? [s.explorer_url] : [] }],
    });
  }
}

export default function InjectedCheckout({ settings, onPurchased }: { settings: PurchaseSettings; onPurchased: (q: number) => void }) {
  const [address, setAddress] = useState<string | null>(null);
  const provider = eth();

  useEffect(() => {
    if (!provider) return;
    provider.request({ method: "eth_accounts" }).then((a) => setAddress((a as string[])[0] ?? null)).catch(() => {});
    const onAccounts = (a: unknown) => setAddress((a as string[])[0] ?? null);
    provider.on?.("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) throw new Error("No wallet found. Install MetaMask or another browser wallet.");
    const a = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    setAddress(a[0] ?? null);
  }, [provider]);

  if (!provider) {
    return <p className="gm-rf-warn">No browser wallet found. Install MetaMask (or another wallet), or ask the organizers to enable email wallets.</p>;
  }

  const adapter: WalletAdapter = {
    ready: true,
    address,
    label: "Wallet",
    connect,
    pay: async ({ to, valueWei, data }) => {
      if (!address) throw new Error("Connect a wallet first");
      await switchToApeChain(provider, settings);
      return (await provider.request({ method: "eth_sendTransaction", params: [{ from: address, to, value: toHex(BigInt(valueWei)), data }] })) as Hex;
    },
  };
  return <CheckoutPanel settings={settings} wallet={adapter} onPurchased={onPurchased} />;
}
