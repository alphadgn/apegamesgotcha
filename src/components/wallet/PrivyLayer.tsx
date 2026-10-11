// App-wide sign-in layer: the app's own sign-in window (ApeGames colours) whose one button opens Glyph's
// sign-in window (Privy cross-app login to Glyph, switched on in the Privy dashboard), plus the bridge from
// that login to the app's Supabase session. Plain PrivyProvider (not the Glyph SDK's provider, which renders
// nothing until a request to useglyph.io succeeds) so the window always shows, with the reason if Glyph
// can't start. Loaded on demand (first time someone opens Sign in, Refill or Add wallet)
// and kept mounted after that.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { apeChain } from "viem/chains";
import { SignInWindow } from "./SignInWindow";
import { GLYPH_LOGIN_METHOD, useGlyphAccount } from "./glyph";
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

/** ApeChain, where Glyph wallets pay (Privy bundles its own viem types, hence the cast). */
const APECHAIN = apeChain as unknown as NonNullable<PrivyClientConfig["defaultChain"]>;

const errorText = (e: unknown) =>
  (e as { shortMessage?: string }).shortMessage ?? (e as Error)?.message ?? "Something went wrong";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The app's sign-in window. Its button opens Glyph's own sign-in window directly (Privy cross-app login to
 * Glyph's app), straight from the tap so browsers don't block it. When Glyph returns, the login is handed
 * to the app: signed out → sign in to the app; signed in → link the Glyph wallet to the account.
 */
function GlyphBridge() {
  const ui = useWalletUi();
  const { user, loading } = useAuth();
  const glyph = useGlyphAccount();
  const { ready, authenticated, getAccessToken } = glyph;
  /** Privy hasn't started after a while: most often this site's address isn't in Privy's allowed domains. */
  const [slow, setSlow] = useState(false);
  const signInFn = useServerFn(privySignIn);
  const linkFn = useServerFn(linkPrivyAccount);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  /** Open for "Add wallet" (link Glyph to the signed-in player) rather than sign-in. */
  const [linkOpen, setLinkOpen] = useState(false);
  const working = useRef(false);

  const mode: "sign-in" | "link" | null =
    ui.signIn && !user ? "sign-in" : linkOpen && user ? "link" : null;

  /** Push the Glyph login (and its wallet) to the server: sign in to the app, or attach to the signed-in player. */
  const bridge = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("Glyph sign-in didn't finish. Please try again.");
    const { data: s } = await supabase.auth.getSession();
    if (s.session) {
      const r = await linkFn({ data: { accessToken: token } });
      if (r.skipped.length)
        toast.warning(
          `Wallet ${short(r.skipped[0]!)} is already linked to another player, so it wasn't added.`,
        );
      return "linked" as const;
    }
    const { tokenHash } = await signInFn({ data: { accessToken: token } });
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error) throw error;
    return "signed-in" as const;
  };

  /** Runs from the button tap: Glyph's window first (if needed), then the hand-over to the app. */
  const continueWithGlyph = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    const then = getWalletUi().afterSignIn;
    try {
      if (!authenticated || !glyph.address) {
        if (authenticated) await glyph.logout(); // a Privy session without Glyph: start clean
        await glyph.login();
      }
      const result = await bridge();
      toast.success(
        result === "signed-in" ? "Signed in with Glyph" : "Glyph wallet added to your account",
      );
      closeSignIn();
      setLinkOpen(false);
      await qc.invalidateQueries();
      if (then === "refill" && result === "signed-in") openRefill();
    } catch (e) {
      const m = errorText(e);
      console.error("[Glyph] sign-in failed:", e);
      // Closing Glyph's window isn't an error worth shouting about.
      if (/closed|cancel|exited|abort/i.test(m)) {
        /* player closed the window */
      } else if (/popup|blocked/i.test(m)) {
        toast.error(
          "Your browser blocked the Glyph window. Allow pop-ups for this site and tap Continue again.",
        );
      } else toast.error(`Glyph sign-in didn't work: ${m}`);
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) void glyph.logout();
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  /** Signed in to Glyph from an earlier visit but want another account: sign out of Glyph, then pick again. */
  const switchAccount = () => {
    void glyph.logout();
  };

  // Privy couldn't start (site not in Privy's allowed domains, wrong App ID, offline): say why instead of
  // loading forever. It keeps trying in the background, so the button appears if it does start.
  useEffect(() => {
    if (ready) {
      setSlow(false);
      return;
    }
    if (!ui.signIn && !linkOpen) return;
    const t = window.setTimeout(() => {
      setSlow(true);
      console.warn(
        `[Glyph] Privy not ready after 12s on ${window.location.origin} — check Privy → App settings → Domains`,
      );
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [ready, ui.signIn, linkOpen]);

  // "Add wallet" from the account page opens the same window, to link Glyph to this account.
  const lastLink = useRef(ui.linkRequest);
  useEffect(() => {
    if (ui.linkRequest === lastLink.current) return;
    lastLink.current = ui.linkRequest;
    setLinkOpen(true);
  }, [ui.linkRequest]);

  // Already signed in to the app when the sign-in window was asked for: nothing to do.
  useEffect(() => {
    if (ui.signIn && user && !working.current) closeSignIn();
  }, [ui.signIn, user]);

  // The app session is the source of truth: signed out of the app → signed out of Glyph too.
  useEffect(() => {
    if (ready && authenticated && !loading && !user && !working.current && !ui.signIn)
      void glyph.logout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, loading, user]);

  const close = () => {
    if (busy) return;
    closeSignIn();
    setLinkOpen(false);
  };
  const remembered = glyph.address;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <SignInWindow
      open={!!mode}
      mode={mode ?? "sign-in"}
      status={
        busy
          ? "Finish in the Glyph window…"
          : slow
            ? "Glyph sign-in can't start on this site yet"
            : undefined
      }
      detail={
        slow && !ready
          ? `Privy didn't start on ${origin}. In the Privy dashboard, add this address under App settings → Domains (allowed origins), then reload.`
          : undefined
      }
      onContinue={ready && !busy ? () => void continueWithGlyph() : undefined}
      continueLabel={remembered ? `Continue as ${short(remembered)}` : "Continue with Glyph"}
      onSwitchAccount={remembered && !busy ? switchAccount : undefined}
      onClose={close}
    />
  );
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
  void onUnavailable; // the window itself now explains when Glyph can't start
  return (
    <PrivyProvider
      appId={config.privy_app_id ?? ""}
      config={{
        // Login with Glyph is the only sign-in option (Glyph itself offers email, social and wallets).
        loginMethodsAndOrder: { primary: [GLYPH_LOGIN_METHOD] },
        appearance: {
          theme: "dark",
          accentColor: "#f6c343",
          landingHeader: "Sign in to ApeGames Gotcha",
        },
        // Glyph provides the wallet; the app doesn't create Privy embedded wallets.
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        defaultChain: APECHAIN,
        supportedChains: [APECHAIN],
      }}
    >
      <GlyphBridge />
      {children}
    </PrivyProvider>
  );
}
