// Mounted once in the root shell. Renders the sign-in window and the Refill (payment) window for the
// whole app. Sign-in is Login with Glyph (through the app's Privy app); payments fall back to a
// browser-extension wallet if Glyph can't load.
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from "react";
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
import { SignInWindow } from "./SignInWindow";
import { BurnDialog } from "./BurnDialog";
import { closeBurn, closeRefill, closeSignIn, useWalletUi } from "./walletUi";

const PrivyLayer = lazy(() => import("./PrivyLayer"));

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
  const [privyFailed, setPrivyFailed] = useState(false);

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

  if (privyOn) {
    return (
      <PrivyBoundary
        onError={() => {
          setPrivyFailed(true);
          toast.error("Glyph sign-in isn't available right now. Please try again in a moment.");
        }}
      >
        <Suspense
          fallback={
            <SignInWindow open={ui.signIn && !user} status="Loading Glyph…" onClose={closeSignIn} />
          }
        >
          <PrivyLayer config={cfg} onUnavailable={privyUnavailable}>
            {refill}
          </PrivyLayer>
        </Suspense>
      </PrivyBoundary>
    );
  }

  // Glyph isn't available (not configured, or it failed to load). Sign-in is Glyph only, so say so plainly;
  // Refill still works for signed-in players through a browser-extension wallet.
  const waiting = !cfg && !isError && !privyFailed;
  return (
    <>
      {refill}
      <SignInWindow
        open={ui.signIn && !user}
        onClose={closeSignIn}
        status={
          waiting
            ? "Loading Glyph…"
            : !cfg?.privy_app_id
              ? "Glyph sign-in isn't set up yet. Please check back soon."
              : "Glyph sign-in couldn't load right now. Check your connection and try again in a moment."
        }
      />
    </>
  );
}
