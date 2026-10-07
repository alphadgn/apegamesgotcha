// Refill checkout through Privy. Rendered inside the app-wide PrivyProvider (see PrivyLayer), and loaded
// on demand so Privy adds nothing to the initial page load.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnectWallet, usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { toHex, type Hex } from "viem";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { CheckoutPanel, type PurchaseSettings, type WalletAdapter } from "./CheckoutPanel";

/** The player's default wallet address (Account → Wallets), lowercase. */
export function useDefaultWalletAddress() {
  return useQuery({
    queryKey: ["default-wallet"],
    queryFn: async () => {
      const db = supabase as unknown as SupabaseClient; // generated types can lag behind migrations
      const { data } = await db
        .from("wallets")
        .select("address")
        .eq("is_default", true)
        .maybeSingle();
      return ((data as { address?: string } | null)?.address ?? null)?.toLowerCase() ?? null;
    },
    staleTime: 30_000,
  });
}

export default function PrivyCheckout({
  settings,
  onPurchased,
}: {
  settings: PurchaseSettings;
  onPurchased: (q: number) => void;
}) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [chosen, setChosen] = useState<string | null>(null); // a wallet the player switched to for this payment
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => setChosen(wallet.address.toLowerCase()),
  });
  const { sendTransaction } = useSendTransaction();
  const { data: defaultAddress } = useDefaultWalletAddress();

  // Pay with the wallet they just switched to, else the default wallet when it's available here; otherwise the Privy wallet, then the latest connected one.
  const wallet =
    wallets.find((w) => chosen && w.address.toLowerCase() === chosen) ??
    wallets.find((w) => defaultAddress && w.address.toLowerCase() === defaultAddress) ??
    wallets.find((w) => w.walletClientType === "privy") ??
    wallets[0] ??
    null;
  const isDefault = !!wallet && wallet.address.toLowerCase() === defaultAddress;

  const adapter: WalletAdapter = {
    ready: ready && walletsReady,
    address: authenticated || wallet ? (wallet?.address ?? null) : null,
    label: `${wallet?.walletClientType === "privy" ? "Privy wallet" : "Wallet"}${isDefault ? " (default)" : ""}`,
    // Not signed in to Privy yet → Privy sign-in (creates a wallet if needed). Signed in → connect another wallet.
    connect: () => (authenticated ? connectWallet() : login()),
    disconnect: () => connectWallet(),
    pay: async ({ to, valueWei, data, chainId }) => {
      if (!wallet) throw new Error("Connect a wallet first");
      if (wallet.walletClientType === "privy") {
        // Embedded wallet: Privy shows its own confirmation and sends on ApeChain.
        const { hash } = await sendTransaction(
          { to, value: BigInt(valueWei), data, chainId },
          { address: wallet.address },
        );
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
