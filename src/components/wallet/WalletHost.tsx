// Mounted once in the root shell. Renders the sign-in window and the Refill (payment) window for the
// whole app. Sign-in is Login with Glyph (through the app's Privy app); payments fall back to a
// browser-extension wallet if Glyph can't load.
import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getPrivyPublicConfig } from "@/lib/app.functions";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefillDialog } from "./RefillDialog";
import { HostedSignInWindow } from "./SignInWindow";
import { BurnDialog } from "./BurnDialog";
import { activateWallet, closeBurn, closeRefill, closeSignIn, openSignIn, useWalletUi } from "./walletUi";

const loadPrivyLayer = () => import("./PrivyLayer");
const PrivyLayer = lazy(loadPrivyLayer);

/**
 * True on the page Glyph's sign-in tab lands on after "Approve": Privy puts its one-time code in the
 * address (?privy_oauth_code=…&privy_oauth_state=…&privy_oauth_provider=privy:…). Privy only hands that
 * code back to the original tab (and closes this one) once PrivyProvider starts on this page.
 */
function isGlyphReturnPage() {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  return q.has("privy_oauth_code") && q.has("privy_oauth_state");
}

/** Shown in Glyph's sign-in tab while it hands the sign-in back to the game tab (instead of the whole site). */
function GlyphReturnScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 8_000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background px-6 text-center">
      <div className="max-w-sm">
        <div
          className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
          style={{ borderColor: "#f6c343", borderTopColor: "transparent" }}
          aria-hidden
        />
        <h1 className="text-2xl font-bold">Finishing sign-in…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {slow
            ? "You're signed in with Glyph. If this tab doesn't close by itself, close it and go back to ApeGames Gotcha."
            : "Handing your Glyph sign-in back to ApeGames Gotcha. This tab closes by itself."}
        </p>
        {slow && (
          <button
            type="button"
            className="mt-5 h-11 rounded-lg px-5 font-bold"
            style={{ backgroundColor: "#f6c343", color: "#141414" }}
            onClick={() => {
              window.close();
              window.setTimeout(() => window.location.replace("/"), 300); // close() not allowed: go to the game
            }}
          >
            Back to the game
          </button>
        )}
      </div>
    </div>
  );
}

class PrivyBoundary extends Component<
  { onError: (m: string) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(e: unknown) {
    console.error("[Privy] failed to load:", e);
    this.props.onError((e as Error)?.message ?? "Privy failed to load");
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function usePrivyPublicConfig(enabled = true) {
  const fn = useServerFn(getPrivyPublicConfig);
  return useQuery({
    queryKey: ["privy-public-config"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function WalletHost() {
  const ui = useWalletUi();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: cfg, isError } = usePrivyPublicConfig(ui.activated);
  const cfgFn = useServerFn(getPrivyPublicConfig);
  const [privyFailed, setPrivyFailed] = useState(false);
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    // Back from Glyph's sign-in tab: start Privy right away so it can hand the sign-in to the game tab.
    if (isGlyphReturnPage()) {
      setReturning(true);
      activateWallet();
      return;
    }
    // Opened from a framed preview to sign in (?signin=1 / ?signin=refill): open the sign-in window here.
    const q = new URLSearchParams(window.location.search);
    const signin = q.get("signin");
    if (signin) {
      q.delete("signin");
      const rest = q.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
      openSignIn(signin === "refill" ? { then: "refill" } : {});
    }
    // Otherwise warm up the sign-in code and settings once the page is idle, so Sign in opens instantly.
    const warm = () => {
      void loadPrivyLayer().catch(() => undefined);
      void qc.prefetchQuery({
        queryKey: ["privy-public-config"],
        queryFn: () => cfgFn(),
        staleTime: 5 * 60_000,
      });
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const id = w.requestIdleCallback ? w.requestIdleCallback(warm) : window.setTimeout(warm, 2_000);
    return () => {
      if (!w.requestIdleCallback) window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPurchased = useCallback(
    (q: number) => {
      toast.success(`${q} spins added to your machine`);
      void qc.invalidateQueries();
      window.setTimeout(closeRefill, 1600);
    },
    [qc],
  );

  const onBurned = useCallback(() => {
    toast.success("Burn confirmed — 1 free spin added to your machine");
    void qc.invalidateQueries();
    window.setTimeout(closeBurn, 1600);
  }, [qc]);

  const privyUnavailable = useCallback(() => {
    console.warn(
      "[Glyph] not ready after 10s — sign-in unavailable; Refill falls back to browser wallets",
    );
    setPrivyFailed(true);
  }, []);

  if (!ui.activated) return null;
  const returnScreen = returning ? <GlyphReturnScreen /> : null;

  const privyOn = !!cfg?.privy_app_id && !privyFailed;
  const refill = (
    <>
      <RefillDialog
        open={ui.refill && !!user}
        onClose={closeRefill}
        onPurchased={onPurchased}
        privy={privyOn}
      />
      <BurnDialog
        target={user ? ui.burn : null}
        onClose={closeBurn}
        onBurned={onBurned}
        privy={privyOn}
      />
    </>
  );

  // One sign-in window for every stage (settings loading → Glyph loading → ready), so it never flashes.
  const waiting = !cfg && !isError && !privyFailed;
  const signIn = (
    <HostedSignInWindow
      fallback={{
        open: ui.signIn && !user,
        onClose: closeSignIn,
        status:
          waiting || privyOn
            ? "Loading Glyph…"
            : !cfg?.privy_app_id
              ? "Glyph sign-in isn't set up yet. Please check back soon."
              : "Glyph sign-in couldn't load right now. Check your connection and try again in a moment.",
      }}
    />
  );

  // The sign-in window always sits first, in the same place, so it isn't rebuilt when Glyph loads.
  return (
    <>
      {signIn}
      {returnScreen}
      {privyOn ? (
        <PrivyBoundary
          onError={() => {
            setPrivyFailed(true);
            toast.error("Glyph sign-in isn't available right now. Please try again in a moment.");
          }}
        >
          <Suspense fallback={null}>
            <PrivyLayer config={cfg} onUnavailable={privyUnavailable}>
              {refill}
            </PrivyLayer>
          </Suspense>
        </PrivyBoundary>
      ) : (
        // Glyph isn't available (not configured, or it failed to load): the window says so; Refill still
        // works for signed-in players through a browser-extension wallet.
        refill
      )}
    </>
  );
}
