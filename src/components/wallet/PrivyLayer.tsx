// App-wide Privy provider + the bridge between a Privy login and the app's Supabase session.
// Loaded on demand (first time someone opens Sign in, Refill or Add wallet) and kept mounted after that.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { PrivyProvider, useLinkAccount, useLogin, usePrivy } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { defineChain } from "viem";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { linkPrivyAccount, privySignIn } from "@/lib/app.functions";
import { closeSignIn, getWalletUi, openRefill, useWalletUi } from "./walletUi";

export type PrivyPublicConfig = {
  privy_app_id: string | null;
  chain_id: number;
  rpc_url: string;
  explorer_url: string | null;
};

const errorText = (e: unknown) =>
  (e as { shortMessage?: string }).shortMessage ?? (e as Error)?.message ?? "Something went wrong";

function PrivyBridge({ onUnavailable }: { onUnavailable: () => void }) {
  const ui = useWalletUi();
  const { user, loading } = useAuth();
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const signInFn = useServerFn(privySignIn);
  const linkFn = useServerFn(linkPrivyAccount);
  const qc = useQueryClient();
  const busy = useRef(false);
  const wantsLink = useRef(false);

  /** Push the Privy login (and its wallets) to the server: sign in to the app, or attach to the signed-in player. */
  const bridge = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("Privy sign-in didn't finish. Please try again.");
    const { data: s } = await supabase.auth.getSession();
    if (s.session) {
      const r = await linkFn({ data: { accessToken: token } });
      if (r.skipped.length)
        toast.warning(
          `Wallet ${r.skipped[0]!.slice(0, 6)}…${r.skipped[0]!.slice(-4)} is already linked to another player, so it wasn't added.`,
        );
      return "linked" as const;
    }
    const { tokenHash } = await signInFn({ data: { accessToken: token } });
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error) throw error;
    return "signed-in" as const;
  };

  const { linkWallet } = useLinkAccount({
    onSuccess: async () => {
      try {
        await bridge();
        toast.success("Wallet added to your account");
        await qc.invalidateQueries();
      } catch (e) {
        toast.error(errorText(e));
      }
    },
  });

  const { login } = useLogin({
    onComplete: async ({ wasAlreadyAuthenticated }) => {
      const asked = getWalletUi().signIn || wantsLink.current;
      const { data: s } = await supabase.auth.getSession();
      // A Privy session left over from before isn't a reason to sign anyone in on its own.
      if (wasAlreadyAuthenticated && !asked && !s.session) return;
      if (busy.current) return;
      busy.current = true;
      try {
        const result = await bridge();
        if (result === "signed-in") toast.success("Signed in");
        await qc.invalidateQueries();
        const then = getWalletUi().afterSignIn;
        closeSignIn();
        if (then === "refill") openRefill();
        if (wantsLink.current) {
          wantsLink.current = false;
          linkWallet();
        }
      } catch (e) {
        toast.error(errorText(e));
        if (!s.session) await logout().catch(() => {});
        closeSignIn();
      } finally {
        busy.current = false;
      }
    },
    onError: (code) => {
      if (code !== "exited_auth_flow") toast.error("Sign-in didn't complete. Please try again.");
      wantsLink.current = false;
      closeSignIn();
    },
  });

  // Privy couldn't start (blocked domain, wrong App ID, offline): fall back to email sign-in instead of doing nothing.
  useEffect(() => {
    if (ready || (!ui.signIn && !ui.refill)) return;
    const t = window.setTimeout(onUnavailable, 10_000);
    return () => window.clearTimeout(t);
  }, [ready, ui.signIn, ui.refill, onUnavailable]);

  // Open Privy's sign-in window whenever the app asks for it.
  useEffect(() => {
    if (!ui.signIn || !ready) return;
    void (async () => {
      if (authenticated) await logout().catch(() => {}); // start clean: sign in as whoever they choose now
      login();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.signIn, ready]);

  // "Add wallet" from the account page.
  const lastLink = useRef(ui.linkRequest);
  useEffect(() => {
    if (!ready || ui.linkRequest === lastLink.current) return;
    lastLink.current = ui.linkRequest;
    if (authenticated) linkWallet();
    else {
      wantsLink.current = true; // sign in to Privy first, then the wallet window opens
      login();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.linkRequest, ready]);

  // The app session is the source of truth: signed out of the app → signed out of Privy too.
  useEffect(() => {
    if (ready && authenticated && !loading && !user && !busy.current && !ui.signIn)
      void logout().catch(() => {});
  }, [ready, authenticated, loading, user, ui.signIn, logout]);

  return null;
}

export default function PrivyLayer({
  config,
  children,
  onUnavailable,
}: {
  config: PrivyPublicConfig;
  children: ReactNode;
  onUnavailable: () => void;
}) {
  const chain = useMemo(
    () =>
      defineChain({
        id: config.chain_id,
        name: "ApeChain",
        testnet: false,
        nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 },
        rpcUrls: { default: { http: [config.rpc_url] } },
        ...(config.explorer_url
          ? { blockExplorers: { default: { name: "ApeScan", url: config.explorer_url } } }
          : {}),
      }),
    [config.chain_id, config.rpc_url, config.explorer_url],
  );
  return (
    <PrivyProvider
      appId={config.privy_app_id ?? ""}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#f6c343",
          walletChainType: "ethereum-only",
          landingHeader: "Sign in to ApeGames Gotcha",
          showWalletLoginFirst: false,
        },
        // Players who sign in without a wallet get one automatically; it becomes their default wallet.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <PrivyBridge onUnavailable={onUnavailable} />
      {children}
    </PrivyProvider>
  );
}
