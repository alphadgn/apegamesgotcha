import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPurchaseSettings } from "@/lib/app.functions";
import type { PurchaseSettings } from "./CheckoutPanel";

const PrivyCheckout = lazy(() => import("./PrivyCheckout"));
const InjectedCheckout = lazy(() => import("./InjectedCheckout"));

/**
 * Keeps a wallet problem (e.g. a blocked domain) inside the Refill window instead of taking down the whole page.
 */
class CheckoutBoundary extends Component<
  { fallback: (message: string) => ReactNode; children: ReactNode },
  { error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: (e as Error)?.message || "Wallet failed to load" };
  }
  override componentDidCatch(e: unknown) {
    console.error("[Refill] wallet provider failed:", e);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function usePurchaseSettings(enabled = true) {
  const settingsFn = useServerFn(getPurchaseSettings);
  return useQuery({
    queryKey: ["purchase-settings"],
    queryFn: async () => (await settingsFn()) as PurchaseSettings,
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Refill window for signed-in players: connect a wallet and buy spins in bundles of 5 (up to 20) with APE on ApeChain.
 * Opens straight to wallet connect + payment. `privy` = rendered inside the app's Privy provider (WalletHost).
 * A plain fixed overlay (not a focus-trapping dialog) so Privy's own windows stay clickable on top.
 */
export function RefillDialog({
  open,
  onClose,
  onPurchased,
  privy,
}: {
  open: boolean;
  onClose: () => void;
  onPurchased: (quantity: number) => void;
  privy: boolean;
}) {
  const { data: settings, isLoading, error } = usePurchaseSettings(open);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  let body;
  if (isLoading) {
    body = <p className="gm-rf-copy">Loading wallet…</p>;
  } else if (!settings) {
    body = (
      <p className="gm-rf-error">
        {(error as Error | null)?.message ?? "Couldn't load checkout. Please try again."}
      </p>
    );
  } else {
    body = (
      <Suspense fallback={<p className="gm-rf-copy">Loading wallet…</p>}>
        {privy ? (
          <CheckoutBoundary
            fallback={() => <InjectedCheckout settings={settings} onPurchased={onPurchased} />}
          >
            <PrivyCheckout settings={settings} onPurchased={onPurchased} />
          </CheckoutBoundary>
        ) : (
          <InjectedCheckout settings={settings} onPurchased={onPurchased} />
        )}
      </Suspense>
    );
  }

  return (
    <div className="gm-rf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gm-rf-panel" role="dialog" aria-modal="true" aria-labelledby="gm-rf-title">
        <div className="gm-rf-head">
          <h2 id="gm-rf-title">Refill spins</h2>
          <button
            ref={closeRef}
            type="button"
            className="gm-rf-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
