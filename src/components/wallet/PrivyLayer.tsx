// App-wide sign-in layer: the app's own sign-in window (ApeGames colours) whose one button opens Glyph's
// sign-in window (Privy cross-app login to Glyph, switched on in the Privy dashboard), plus the bridge from
// that login to the app's Supabase session. Plain PrivyProvider (not the Glyph SDK's provider, which renders
// nothing until a request to useglyph.io succeeds) so the window always shows, with the reason if Glyph
// can't start. Loaded on demand (first time someone opens Sign in, Refill or Add wallet)
// and kept mounted after that.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  PrivyProvider,
  useConnectWallet,
  useModalStatus,
  type PrivyClientConfig,
} from "@privy-io/react-auth";
import { apeChain, base, mainnet } from "viem/chains";
import { setSignInControls } from "./SignInWindow";
import { glyphAddress, useGlyphAccount } from "./glyph";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  getWalletNonce,
  getWalletSignInChallenge,
  linkPrivyAccount,
  linkWallet,
  privySignIn,
} from "@/lib/app.functions";
import { MAX_WALLETS } from "@/lib/wallet-limits";
import {
  closeSignIn,
  getWalletUi,
  openRefill,
  openSignIn,
  registerPrivyLogout,
  useWalletUi,
} from "./walletUi";

export type PrivyPublicConfig = {
  privy_app_id: string | null;
  chain_id: number;
  rpc_url: string;
  explorer_url: string | null;
  walletconnect_project_id?: string | null;
};

/** Wallets players can connect from "Add wallet" (WalletConnect covers most mobile wallets, incl. Rabby). */
const EXTERNAL_WALLETS: NonNullable<NonNullable<PrivyClientConfig["appearance"]>["walletList"]> = [
  "detected_ethereum_wallets",
  "metamask",
  "wallet_connect",
  "coinbase_wallet",
  "rainbow",
];

/**
 * Networks offered to outside wallets (MetaMask, WalletConnect…) as optional. ApeChain stays first, so it's the
 * default, but it is NOT required: when PrivyProvider gets `defaultChain`, Privy makes that chain *required* in the
 * WalletConnect request, and phone wallets that don't have ApeChain set up (MetaMask) refuse the connection
 * ("Waiting for MetaMask — Please try connecting again"). Adding a wallet only needs a signature, which works on
 * any network; Glyph payments and burns name ApeChain explicitly.
 */
const CHAINS = [apeChain, mainnet, base] as unknown as NonNullable<PrivyClientConfig["supportedChains"]>;

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
  const nonceFn = useServerFn(getWalletNonce);
  const linkWalletFn = useServerFn(linkWallet);
  const [busy, setBusy] = useState(false);
  /** Open for "Add wallet" (link Glyph to the signed-in player) rather than sign-in. */
  const [linkOpen, setLinkOpen] = useState(false);
  /** Glyph's window has taken over: our window steps aside until it finishes (or fails). */
  const [handedOff, setHandedOff] = useState(false);
  const working = useRef(false);

  const mode: "sign-in" | "link" | null =
    ui.signIn && !user ? "sign-in" : linkOpen && user ? "link" : null;

  type Proof = { message: string; token: string; signature: string };
  /** Push the Glyph login (and its wallet) to the server: sign in to the app, or attach to the signed-in player. */
  const bridge = async (proof: Proof) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Glyph sign-in didn't finish. Please try again.");
    const { data: s } = await supabase.auth.getSession();
    if (s.session) {
      const r = await linkFn({ data: { accessToken: token, proof } });
      if (r.skipped.length)
        toast.warning(
          `Wallet ${short(r.skipped[0]!)} wasn't added: it's linked to another player, or this account already has 5 wallets.`,
        );
      return "linked" as const;
    }
    const { tokenHash } = await signInFn({ data: { accessToken: token, proof } });
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    if (error) throw error;
    return "signed-in" as const;
  };

  /**
   * Step 2 of 2, waiting for the player's tap: the one-time message their Glyph wallet must sign. Glyph's
   * "Approve" (step 1) only grants access; this signature proves the player controls the wallet, and the
   * server checks it before signing in or linking.
   */
  const [challenge, setChallenge] = useState<{
    address: string;
    message: string;
    token: string;
    then: "refill" | null;
    mode: "sign-in" | "link";
  } | null>(null);
  const challengeFn = useServerFn(getWalletSignInChallenge);

  const reportError = (e: unknown) => {
    const m = errorText(e);
    console.error("[Glyph] sign-in failed:", e);
    if (/popup|blocked/i.test(m)) {
      toast.error("Your browser blocked the Glyph window. Allow pop-ups for this site and try again.");
    } else if (/redirect|origin|domain|not allowed|allowlist/i.test(m)) {
      toast.error(
        `Glyph sign-in isn't allowed on ${window.location.origin} yet: add it in Privy → App settings → Domains. (${m})`,
        { duration: 15_000 },
      );
    } else if (/closed|cancel|exited|abort|reject|denied/i.test(m)) {
      toast.message("The Glyph window was closed before it finished. Try again when you're ready.");
    } else toast.error(`Glyph sign-in didn't work: ${m}`);
  };

  /** Step 1 of 2 (from the tap): Glyph's sign-in window and "Approve", then fetch the message to sign. */
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
      let address = glyph.address;
      if (!authenticated || !address) {
        if (authenticated) await glyph.logout(); // a Privy session without Glyph: start clean
        const u = await glyph.login();
        address = glyphAddress(u);
      }
      if (!address) throw new Error("Glyph didn't return a wallet. Please try again.");
      const c = await challengeFn({ data: { address, origin: window.location.origin } });
      setChallenge({ address, message: c.message, token: c.token, then, mode: wasMode ?? "sign-in" });
    } catch (e) {
      failed = true;
      reportError(e);
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

  /** Step 2 of 2 (from the tap): the Glyph wallet signs the message, then the server checks it and signs in. */
  const signWithGlyph = async () => {
    const c = challenge;
    if (!c || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const signature = await glyph.signMessage(c.message, c.address);
      const result = await bridge({ message: c.message, token: c.token, signature });
      toast.success(result === "signed-in" ? "Signed in with Glyph" : "Glyph wallet added to your account");
      setChallenge(null);
      closeSignIn();
      setLinkOpen(false);
      await qc.invalidateQueries();
      if (c.then === "refill") openRefill();
    } catch (e) {
      reportError(e);
      // A stale or rejected message: get a fresh one so the next tap works.
      if (/expired|wasn't issued|didn't check out/i.test(errorText(e))) {
        const fresh = await challengeFn({ data: { address: c.address, origin: window.location.origin } }).catch(() => null);
        if (fresh) setChallenge({ ...c, message: fresh.message, token: fresh.token });
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  /** Closing the window mid-way (after Approve, before signing): nothing is signed in, so drop Glyph too. */
  const cancelChallenge = async () => {
    setChallenge(null);
    const { data: s } = await supabase.auth.getSession();
    if (!s.session) void glyph.logout();
  };

  // Sign-out (menu) ends the Glyph / Privy session through this.
  useEffect(() => {
    registerPrivyLogout(() => Promise.resolve(glyph.logout()).then(() => undefined));
    return () => registerPrivyLogout(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Signed out of the app but a Glyph session is still saved in this browser (e.g. an older sign-out):
  // clear it before offering sign-in, so signing in always goes through Glyph again — never a one-tap
  // "continue as" back into an account.
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (mode !== "sign-in" || !ready || !authenticated || working.current || clearing || challenge) return;
    setClearing(true);
    void Promise.resolve(glyph.logout()).finally(() => setClearing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ready, authenticated, challenge]);

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

  // ---- Add wallet: the player's wallets, and connecting any other wallet (WalletConnect, MetaMask…) ----
  const { data: myWallets } = useQuery({
    queryKey: ["my-wallet-addresses", user?.id],
    enabled: !!user,
    queryFn: async () =>
      (
        ((await supabase.from("wallets").select("address").eq("user_id", user!.id)).data ?? []) as {
          address: string;
        }[]
      ).map((w) => w.address.toLowerCase()),
  });
  const walletCount = myWallets?.length ?? 0;
  const walletsFull = walletCount >= MAX_WALLETS;
  const glyphLinked = !!glyph.address && !!myWallets?.includes(glyph.address.toLowerCase());

  /** null = idle; "connecting" = Privy's wallet picker is open; "signing" = proving ownership. */
  const external = useRef<null | "connecting" | "signing">(null);
  const externalThen = useRef<"refill" | null>(null);
  /**
   * When the player last opened the wallet picker. On phones, WalletConnect hands over to the wallet app and
   * Privy's picker closes before the wallet answers, so a late "connected" callback still counts for a few
   * minutes even after our window came back (it used to be dropped, and the wallet was never added).
   */
  const connectStarted = useRef(0);
  const CONNECT_WINDOW_MS = 3 * 60_000;
  const endExternal = (ok: boolean) => {
    external.current = null;
    setBusy(false);
    setHandedOff(false);
    if (ok) {
      setLinkOpen(false);
      void qc.invalidateQueries();
      if (externalThen.current === "refill") openRefill();
    } else setLinkOpen(true); // bring the Add wallet window back
    externalThen.current = null;
  };
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (external.current === "signing" || Date.now() - connectStarted.current > CONNECT_WINDOW_MS) return;
      connectStarted.current = 0;
      external.current = "signing";
      setHandedOff(true); // the window may have come back meanwhile: step aside again while the wallet signs
      setBusy(true);
      void (async () => {
        try {
          if (!("getEthereumProvider" in wallet))
            throw new Error("Pick an Ethereum (ApeChain) wallet.");
          const provider = await wallet.getEthereumProvider();
          const { message } = await nonceFn();
          const signature = (await provider.request({
            method: "personal_sign",
            params: [message, wallet.address],
          })) as string;
          await linkWalletFn({ data: { address: wallet.address, signature } });
          toast.success(`Wallet ${short(wallet.address)} added`);
          endExternal(true);
        } catch (e) {
          const m = errorText(e);
          toast.error(
            /reject|denied|cancel/i.test(m)
              ? "Signature cancelled, so the wallet wasn't added."
              : m,
          );
          endExternal(false);
        }
      })();
    },
    onError: (err) => {
      if (external.current !== "connecting") return;
      connectStarted.current = 0;
      if (!/exited|cancel|closed/i.test(String(err)))
        toast.error(`Couldn't connect that wallet (${String(err)}).`);
      endExternal(false);
    },
  });
  const connectExternal = () => {
    if (external.current || working.current) return;
    external.current = "connecting";
    connectStarted.current = Date.now();
    externalThen.current = getWalletUi().afterSignIn;
    // Step aside first: Privy's wallet picker can't work under our open window (focus trap).
    setHandedOff(true);
    setBusy(true);
    connectWallet({
      walletList: EXTERNAL_WALLETS,
      walletChainType: "ethereum-only",
      description: "Pick the wallet to add. It signs a free message to prove it's yours.",
    });
  };
  // Privy's wallet picker closed without a wallet: bring our window back.
  const { isOpen: privyModalOpen } = useModalStatus();
  const wasModalOpen = useRef(false);
  useEffect(() => {
    if (privyModalOpen) {
      wasModalOpen.current = true;
      return;
    }
    if (!wasModalOpen.current) return;
    wasModalOpen.current = false;
    // Give a wallet app time to answer (the player may be switching apps); a late answer is still accepted.
    let t = 0;
    const settle = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (document.visibilityState === "hidden") return settle(); // still in the wallet app
        if (external.current === "connecting") endExternal(false);
      }, 2500);
    };
    settle();
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privyModalOpen]);

  const close = () => {
    if (busy) return;
    if (challenge) void cancelChallenge();
    closeSignIn();
    setLinkOpen(false);
  };
  const remembered = glyph.address;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  // Inside a frame (e.g. the Lovable editor's preview), Glyph's sign-in tab can't report back: browsers
  // (iPhone Safari above all) wall off a framed page's storage and its link to the tab it opens, so that tab
  // stayed on about:blank. Sign in from the site's own tab instead; the sign-in window opens there by itself.
  const framed = (() => {
    if (typeof window === "undefined") return false;
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  const openOwnTab = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("signin", getWalletUi().afterSignIn === "refill" ? "refill" : "1");
    window.open(url.toString(), "_blank", "noopener");
  };
  const framedProps = {
    status: undefined,
    detail: undefined,
    onContinue: openOwnTab,
    continueLabel: "Open sign-in in a new tab",
    secondary: undefined,
    note: "This page is shown inside a frame (like the Lovable editor preview), where Glyph's sign-in window can't connect back. Sign in on the site in its own tab: the sign-in window opens there automatically.",
    onSwitchAccount: undefined,
  };

  const linking = mode === "link";
  const linkProps = {
    status: walletsFull
      ? `${MAX_WALLETS} of ${MAX_WALLETS} wallets linked`
      : glyphLinked
        ? "Glyph wallet linked ✓"
        : busy
          ? "Finish in the wallet window…"
          : undefined,
    onContinue:
      ready && !busy && !walletsFull && !glyphLinked ? () => void continueWithGlyph() : undefined,
    continueLabel: remembered ? `Link Glyph wallet ${short(remembered)}` : "Link a Glyph wallet",
    secondary: {
      label: "Connect another wallet (WalletConnect, MetaMask…)",
      onClick: ready && !busy && !walletsFull ? connectExternal : undefined,
    },
    note: walletsFull
      ? `You've linked the maximum of ${MAX_WALLETS} wallets.`
      : `${walletCount} of ${MAX_WALLETS} wallets linked`,
    onSwitchAccount: undefined,
  };
  const props = {
    open: !!mode,
    mode: mode ?? "sign-in",
    status: busy
      ? "Finish in the Glyph window…"
      : clearing || (ready && authenticated)
        ? "Getting Glyph ready…"
        : slow
          ? "Glyph sign-in can't start on this site yet"
          : undefined,
    detail:
      slow && !ready
        ? `Privy didn't start on ${origin}. In the Privy dashboard, add this address under App settings → Domains (allowed origins), then reload.`
        : undefined,
    onContinue:
      ready && !busy && !clearing && !authenticated ? () => void continueWithGlyph() : undefined,
    continueLabel: "Continue with Glyph",
    note: "Step 1 of 2: approve in Glyph. Step 2: sign a free message to prove the wallet is yours.",
    onSwitchAccount: undefined,
    onClose: close,
    hidden: handedOff,
    ...(linking ? linkProps : {}),
    ...(framed && !challenge ? framedProps : {}),
    // Step 2 of 2: sign the one-time message with the Glyph wallet (after Glyph's "Approve").
    ...(challenge
      ? {
          status: busy ? "Sign in the Glyph window…" : undefined,
          onContinue: !busy ? () => void signWithGlyph() : undefined,
          continueLabel: "Sign message in Glyph",
          secondary: undefined,
          note: `Step 2 of 2: sign a one-time message with your Glyph wallet ${short(challenge.address)} to prove it's yours. It's free: no transaction, no gas.`,
          detail: undefined,
          onSwitchAccount: undefined,
        }
      : {}),
  };
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
        // No loginMethodsAndOrder: sign-in never uses Privy's login window (our button opens Glyph directly),
        // and setting it makes Privy build the "connect a wallet" list from it, which emptied that list.
        appearance: {
          theme: "dark",
          accentColor: "#f6c343",
          landingHeader: "Sign in to ApeGames Gotcha",
          // Wallets offered by "Add wallet → Connect another wallet". Installed browser wallets (Rabby,
          // Brave, OKX…) appear under "detected" wallets; WalletConnect covers mobile wallet apps.
          walletList: EXTERNAL_WALLETS,
          walletChainType: "ethereum-only",
        },
        // Glyph provides the wallet; the app doesn't create Privy embedded wallets.
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        // No defaultChain on purpose (see CHAINS): ApeChain is first, so it is still the default network.
        supportedChains: CHAINS,
        ...(config.walletconnect_project_id ? { walletConnectCloudProjectId: config.walletconnect_project_id } : {}),
      }}
    >
      <GlyphBridge />
      {children}
    </PrivyProvider>
  );
}
