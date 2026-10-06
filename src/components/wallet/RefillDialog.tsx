import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PurchaseSettings } from "./CheckoutPanel";

const PrivyCheckout = lazy(() => import("./PrivyCheckout"));
const InjectedCheckout = lazy(() => import("./InjectedCheckout"));

/**
 * Keeps a wallet problem (e.g. a wrong Privy App ID or a blocked domain) inside the Refill window
 * instead of taking down the whole page.
 */
class CheckoutBoundary extends Component<{ fallback: (message: string) => ReactNode; children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: (e as Error)?.message || "Wallet sign-in failed to load" };
  }
  override componentDidCatch(e: unknown) {
    console.error("[Refill] wallet provider failed:", e);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function usePurchaseSettings() {
  return useQuery({
    queryKey: ["purchase-settings"],
    queryFn: async () => {
      const { data } = await supabase.from("app_config").select("value").eq("key", "purchase").maybeSingle();
      return (data?.value ?? null) as PurchaseSettings | null;
    },
    staleTime: 60_000,
  });
}

/**
 * Refill window: buy spins in bundles of 5 (up to 20) with APE on ApeChain.
 * A plain fixed overlay (not a focus-trapping dialog) so Privy's own login window stays clickable on top.
 */
export function RefillDialog({
  open,
  onClose,
  signedIn,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  signedIn: boolean;
  onPurchased: (quantity: number) => void;
}) {
  const { data: settings, isLoading } = usePurchaseSettings();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ready = settings?.enabled && /^0x[0-9a-fA-F]{40}$/.test(settings.treasury ?? "");
  let body;
  if (!signedIn) {
    body = (
      <div className="gm-rf">
        <p className="gm-rf-copy">Sign in to buy real spins. Purchased spins are drawn on-chain and earn leaderboard points.</p>
        <Link to="/auth" className="gm-rf-cta" onClick={onClose}>
          Sign in to buy spins
        </Link>
      </div>
    );
  } else if (isLoading) {
    body = <p className="gm-rf-copy">Loading…</p>;
  } else if (!ready || !settings) {
    body = <p className="gm-rf-copy">Spin purchases open soon. Check back when the organizers turn on checkout.</p>;
  } else {
    body = (
      <Suspense fallback={<p className="gm-rf-copy">Loading wallet…</p>}>
        {settings.privy_app_id ? (
          <CheckoutBoundary
            fallback={(message) => (
              <>
                <p className="gm-rf-warn">
                  Email wallet sign-in isn't available right now{/invalid.*app id/i.test(message) ? " (the Privy App ID in Admin → Configuration → purchase isn't valid)" : ""}. You can still pay with a browser wallet.
                </p>
                <InjectedCheckout settings={settings} onPurchased={onPurchased} />
              </>
            )}
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
          <button ref={closeRef} type="button" className="gm-rf-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
