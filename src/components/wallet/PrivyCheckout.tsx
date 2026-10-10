// Refill checkout with the player's Glyph wallet (Login with Glyph, through the app's Privy app). Rendered inside the app-wide PrivyProvider (see PrivyLayer), and loaded
// on demand so Privy adds nothing to the initial page load.
import { useQuery } from "@tanstack/react-query";
import { useGlyph } from "@use-glyph/sdk-react";
import type { Hex } from "viem";
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

/**
 * A WalletAdapter backed by the player's Glyph wallet (Login with Glyph). Glyph shows its own confirmation
 * and sends on ApeChain. `prefer` is accepted for callers that care which wallet is used (e.g. burns); the
 * Glyph wallet is the only one this adapter can sign with.
 */
export function usePrivyWalletAdapter(prefer?: string | null): WalletAdapter {
  void prefer;
  const glyph = useGlyph();
  const address = glyph.authenticated ? (glyph.user?.evmWallet ?? null) : null;
  return {
    ready: glyph.ready,
    address,
    label: "Glyph wallet",
    connect: () => glyph.login(),
    pay: async ({ to, valueWei, data, chainId }) => {
      if (!address) throw new Error("Sign in with Glyph first");
      const hash = await glyph.sendTransaction({ transaction: { to, value: BigInt(valueWei), data, chainId } });
      return hash as Hex;
    },
  };
}

export default function PrivyCheckout({
  settings,
  onPurchased,
}: {
  settings: PurchaseSettings;
  onPurchased: (q: number) => void;
}) {
  const adapter = usePrivyWalletAdapter();
  return <CheckoutPanel settings={settings} wallet={adapter} onPurchased={onPurchased} />;
}
