// The burn window (same overlay as Refill so Privy's own windows stay clickable on top).
import { lazy, Suspense, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getNftSettings } from "@/lib/app.functions";
import type { BurnTarget } from "./walletUi";

const PrivyBurn = lazy(() => import("./PrivyBurn"));
const InjectedBurn = lazy(() => import("./InjectedBurn"));

export function BurnDialog({
  target,
  onClose,
  onBurned,
  privy,
}: {
  target: BurnTarget | null;
  onClose: () => void;
  onBurned: () => void;
  privy: boolean;
}) {
  const settingsFn = useServerFn(getNftSettings);
  const {
    data: nft,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["nft-settings"],
    queryFn: () => settingsFn(),
    staleTime: 60_000,
    enabled: !!target,
  });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!target) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  let body;
  if (isLoading) body = <p className="gm-rf-copy">Loading…</p>;
  else if (!nft)
    body = (
      <p className="gm-rf-error">
        {(error as Error | null)?.message ?? "Couldn't load the burn settings."}
      </p>
    );
  else
    body = (
      <Suspense fallback={<p className="gm-rf-copy">Loading wallet…</p>}>
        {privy ? (
          <PrivyBurn nft={nft} target={target} onBurned={onBurned} />
        ) : (
          <InjectedBurn nft={nft} target={target} onBurned={onBurned} />
        )}
      </Suspense>
    );

  return (
    <div className="gm-rf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gm-rf-panel" role="dialog" aria-modal="true" aria-labelledby="gm-burn-title">
        <div className="gm-rf-head">
          <h2 id="gm-burn-title">Burn for a free spin</h2>
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
