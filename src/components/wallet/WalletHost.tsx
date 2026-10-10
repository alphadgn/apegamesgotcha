// Mounted once in the root shell. Renders the sign-in window and the Refill (payment) window for the
// whole app, inside Privy when a Privy App ID is configured, with an email/browser-wallet fallback otherwise.
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
import { EmailSignInForm } from "./EmailSignInForm";
import { RefillDialog } from "./RefillDialog";
import { BurnDialog } from "./BurnDialog";
import { closeBurn, closeRefill, closeSignIn, getWalletUi, openRefill, useWalletUi } from "./walletUi";

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
    console.warn("[Privy] not ready after 10s — using email sign-in and browser wallets instead");
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
      <BurnDialog target={user ? ui.burn : null} onClose={closeBurn} onBurned={onBurned} privy={privyOn} />
    </>
  );

  if (privyOn) {
    return (
      <PrivyBoundary
        onError={() => {
          setPrivyFailed(true);
          if (getWalletUi().signIn)
            toast.error("Wallet sign-in isn't available right now — use email instead.");
        }}
      >
        <Suspense fallback={null}>
          <PrivyLayer config={cfg} onUnavailable={privyUnavailable}>
            {refill}
          </PrivyLayer>
        </Suspense>
      </PrivyBoundary>
    );
  }

  // No Privy (not configured, or it failed to load): email/Google sign-in and browser-extension wallets.
  const waiting = !cfg && !isError && !privyFailed;
  return (
    <>
      {refill}
      <Dialog open={ui.signIn && !user} onOpenChange={(o) => !o && closeSignIn()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sign in</DialogTitle>
            <DialogDescription>
              Sign in to buy spins, win real prizes and earn leaderboard points.
            </DialogDescription>
          </DialogHeader>
          {waiting ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (
            <EmailSignInForm
              onSignedIn={() => {
                const then = getWalletUi().afterSignIn;
                closeSignIn();
                if (then === "refill") openRefill();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
