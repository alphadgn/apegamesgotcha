// App-wide sign-in layer: the app's own sign-in window (ApeGames colours) whose one button opens Glyph's
// sign-in window (Privy cross-app login to Glyph, switched on in the Privy dashboard), plus the bridge from
// that login to the app's Supabase session. Plain PrivyProvider (not the Glyph SDK's provider, which renders
// nothing until a request to useglyph.io succeeds) so the window always shows, with the reason if Glyph
// can't start. Loaded on demand (first time someone opens Sign in, Refill or Add wallet)
// and kept mounted after that.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { apeChain } from "viem/chains";
import { setSignInControls } from "./SignInWindow";
import { GLYPH_LOGIN_METHOD, useGlyphAccount } from "./glyph";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { linkPrivyAccount, privySignIn } from "@/lib/app.functions";
import { closeSignIn, getWalletUi, openRefill, openSignIn, useWalletUi } from "./walletUi";

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
  /** Glyph's window has taken over: our window steps aside until it finishes (or fails). */
  const [handedOff, setHandedOff] = useState(false);
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
    const then = getWalletUi().afterSignIn;
    const wasMode = mode;
    // Get our window out of the way before Privy shows its "Connecting to Glyph" step. Two modal windows
    // at once fight over focus and taps; Privy then reads that as the player closing its window, cancels,
    // and the Glyph tab it already opened stays blank (about:blank). Unmounting (not just hiding) releases
    // our window's focus trap immediately, before Privy's step appears.
    setHandedOff(true);
    setBusy(true);
    let failed = false;
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
      if (then === "refill") openRefill();
    } catch (e) {
      failed = true;
      const m = errorText(e);
      console.error("[Glyph] sign-in failed:", e);
      if (/popup|blocked/i.test(m)) {
        toast.error(
          "Your browser blocked the Glyph window. Allow pop-ups for this site and tap Continue again.",
        );
      } else if (/redirect|origin|domain|not allowed|allowlist/i.test(m)) {
        toast.error(
          `Glyph sign-in isn't allowed on ${window.location.origin} yet: add it in Privy → App settings → Domains. (${m})`,
          { duration: 15_000 },
        );
      } else if (/closed|cancel|exited|abort/i.test(m)) {
        toast.message(
          "Glyph sign-in was closed before it finished. Tap Continue with Glyph to try again.",
        );
      } else toast.error(`Glyph sign-in didn't work: ${m}`);
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) void glyph.logout();
    } finally {
      working.current = false;
      setBusy(false);
      setHandedOff(false);
      // Didn't finish: bring our window back so the player can try again.
      if (failed) {
        if (wasMode === "sign-in") openSignIn(then === "refill" ? { then: "refill" } : {});
        else if (wasMode === "link") setLinkOpen(true);
      }
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

  // Signing out of the app signs out of Glyph too. Only on an actual sign-out (a player was signed in and
  // now isn't): Privy's session is shared by every tab of the site, so logging out just because this tab
  // has no player yet would cut off a sign-in finishing in another tab (e.g. Glyph's returning tab).
  const hadUser = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (user) {
      hadUser.current = true;
      return;
    }
    if (!hadUser.current || !ready || working.current) return; // wait until Privy can act
    if (authenticated) void glyph.logout();
    hadUser.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, loading, user]);

  const close = () => {
    if (busy) return;
    closeSignIn();
    setLinkOpen(false);
  };
  const remembered = glyph.address;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const props = {
    open: !!mode,
    mode: mode ?? "sign-in",
    status: busy
      ? "Finish in the Glyph window…"
      : slow
        ? "Glyph sign-in can't start on this site yet"
        : undefined,
    detail:
      slow && !ready
        ? `Privy didn't start on ${origin}. In the Privy dashboard, add this address under App settings → Domains (allowed origins), then reload.`
        : undefined,
    onContinue: ready && !busy ? () => void continueWithGlyph() : undefined,
    continueLabel: remembered ? `Continue as ${short(remembered)}` : "Continue with Glyph",
    onSwitchAccount: remembered && !busy ? switchAccount : undefined,
    onClose: close,
    hidden: handedOff,
  } as const;
  // Feed the app's one sign-in window (rendered by WalletHost) rather than rendering a second one.
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    setSignInControls({ ...latest.current });
  });
  useEffect(() => () => setSignInControls(null), []);

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
