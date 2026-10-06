// Loaded on demand when the Refill window opens, so Privy adds nothing to the initial page load.
import { useMemo } from "react";
import { PrivyProvider, useConnectWallet, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { defineChain, toHex, type Hex } from "viem";
import { CheckoutPanel, type PurchaseSettings, type WalletAdapter } from "./CheckoutPanel";

function apeChainFor(s: PurchaseSettings) {
  return defineChain({
    id: s.chain_id,
    name: "ApeChain",
    testnet: false,
    nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 },
    rpcUrls: { default: { http: [s.rpc_url] } },
    ...(s.explorer_url ? { blockExplorers: { default: { name: "ApeScan", url: s.explorer_url } } } : {}),
  });
}

function PrivyWallet({ settings, onPurchased }: { settings: PurchaseSettings; onPurchased: (q: number) => void }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { connectWallet } = useConnectWallet();
  const { sendTransaction } = useSendTransaction();
  const wallet = wallets[0] ?? null; // most recently connected first

  const adapter: WalletAdapter = {
    ready: ready && walletsReady,
    address: authenticated || wallet ? wallet?.address ?? null : null,
    label: wallet?.walletClientType === "privy" ? "Privy wallet" : wallet ? "Wallet" : "Wallet",
    // Email or wallet sign-in through Privy; signed-in players can add another wallet.
    connect: () => (authenticated ? connectWallet() : login()),
    disconnect: async () => {
      if (wallet && wallet.walletClientType !== "privy") wallet.disconnect();
      if (authenticated) await logout();
    },
    pay: async ({ to, valueWei, data, chainId }) => {
      if (!wallet) throw new Error("Connect a wallet first");
      if (wallet.walletClientType === "privy") {
        // Embedded (email) wallet: Privy shows its own confirmation and sends on ApeChain.
        const { hash } = await sendTransaction({ to, value: BigInt(valueWei), data, chainId }, { address: wallet.address });
        return hash;
      }
      // External wallet (MetaMask, Coinbase, Rainbow…): switch to ApeChain, then send.
      await wallet.switchChain(chainId);
      const provider = await wallet.getEthereumProvider();
      return (await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to, value: toHex(BigInt(valueWei)), data }],
      })) as Hex;
    },
  };

  return <CheckoutPanel settings={settings} wallet={adapter} onPurchased={onPurchased} />;
}

export default function PrivyCheckout({ settings, onPurchased }: { settings: PurchaseSettings; onPurchased: (q: number) => void }) {
  const chain = useMemo(() => apeChainFor(settings), [settings]);
  return (
    <PrivyProvider
      appId={settings.privy_app_id ?? ""}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: { theme: "dark", accentColor: "#f6c343", walletChainType: "ethereum-only" },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <PrivyWallet settings={settings} onPurchased={onPurchased} />
    </PrivyProvider>
  );
}
