// App-wide sign-in layer: Login with Glyph (Yuga Labs' ApeChain wallet) through the app's Privy app
// (Privy cross-app login, with Glyph switched on in the Privy dashboard), plus the bridge from that login
// to the app's Supabase session. Loaded on demand (first time someone opens Sign in, Refill or Add wallet)
// and kept mounted after that.
import { useEffect, useRef, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { GLYPH_APP_LOGIN_METHOD, GlyphPrivyProvider, useGlyph } from "@use-glyph/sdk-react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
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

function GlyphBridge({ onUnavailable }: { onUnavailable: () => void }) {
  const ui = useWalletUi();
  const { user, loading } = useAuth();
  const { ready, authenticated, getAccessToken } = usePrivy();
  const glyph = useGlyph();
  const signInFn = useServerFn(privySignIn);
  const linkFn = useServerFn(linkPrivyAccount);
  const qc = useQueryClient();
  const busy = useRef(false);
  /** A Glyph login we started and still have to hand to the app: sign in, or link to the signed-in player. */
  const pending = useRef<{ then: "refill" | null; link: boolean } | null>(null);

  /** Push the Glyph login (and its wallet) to the server: sign in to the app, or attach to the signed-in player. */
  const bridge = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("Glyph sign-in didn't finish. Please try again.");
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

  // Finish a Glyph login we asked for, once Privy reports the player authenticated.
  useEffect(() => {
    const p = pending.current;
    if (!p || !ready || !authenticated || busy.current) return;
    busy.current = true;
    pending.current = null;
    void (async () => {
      try {
        const result = await bridge();
        toast.success(result === "signed-in" ? "Signed in with Glyph" : "Glyph wallet added to your account");
        await qc.invalidateQueries();
        if (p.then === "refill") openRefill();
      } catch (e) {
        toast.error(errorText(e));
        const { data: s } = await supabase.auth.getSession();
        if (!s.session) glyph.logout();
      } finally {
        busy.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  // Glyph couldn't start (blocked domain, wrong App ID, offline): tell the player instead of doing nothing.
  useEffect(() => {
    if (ready || (!ui.signIn && !ui.refill)) return;
    const t = window.setTimeout(onUnavailable, 10_000);
    return () => window.clearTimeout(t);
  }, [ready, ui.signIn, ui.refill, onUnavailable]);

  const startGlyphLogin = (p: { then: "refill" | null; link: boolean }) => {
    pending.current = p;
    if (authenticated) {
      // Already signed in to Glyph (e.g. from an earlier visit): hand that login over straight away.
      busy.current = false;
      void (async () => {
        if (!p.link) {
          glyph.logout(); // start clean: sign in as whoever they choose now
          window.setTimeout(() => glyph.login(), 300);
        } else {
          pending.current = null;
          try {
            await bridge();
            toast.success("Glyph wallet added to your account");
            await qc.invalidateQueries();
          } catch (e) {
            toast.error(errorText(e));
          }
        }
      })();
      return;
    }
    glyph.login();
  };

  // Open Glyph's sign-in window whenever the app asks for it.
  useEffect(() => {
    if (!ui.signIn || !ready) return;
    const then = getWalletUi().afterSignIn;
    closeSignIn(); // Glyph shows its own window; ours only had to start it
    startGlyphLogin({ then, link: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.signIn, ready]);

  // "Add wallet" from the account page: link the player's Glyph wallet to their account.
  const lastLink = useRef(ui.linkRequest);
  useEffect(() => {
    if (!ready || ui.linkRequest === lastLink.current) return;
    lastLink.current = ui.linkRequest;
    startGlyphLogin({ then: null, link: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.linkRequest, ready]);

  // The app session is the source of truth: signed out of the app → signed out of Glyph too.
  useEffect(() => {
    if (ready && authenticated && !loading && !user && !busy.current && !pending.current) glyph.logout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, loading, user]);

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
  const queryClient = useQueryClient(); // share the app's cache so purchases/burns refresh the page
  return (
    <GlyphPrivyProvider
      appId={config.privy_app_id ?? ""}
      queryClient={queryClient}
      config={{
        // Login with Glyph is the only sign-in option (Glyph itself offers email, social and wallets).
        loginMethodsAndOrder: { primary: [GLYPH_APP_LOGIN_METHOD] },
        appearance: { theme: "dark", accentColor: "#f6c343", landingHeader: "Sign in to ApeGames Gotcha" },
        // Glyph provides the wallet; the app doesn't create Privy embedded wallets any more.
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
      }}
    >
      <GlyphBridge onUnavailable={onUnavailable} />
      {children}
    </GlyphPrivyProvider>
  );
}
