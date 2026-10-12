// "Add wallet" on a phone, without WalletConnect: opens this site inside the wallet app's own browser
// (MetaMask, Coinbase Wallet, Trust), where the wallet signs the verification message on /link-wallet.
// The link carries a one-time code (the account's fresh verification nonce, valid 15 minutes).
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SIGN_IN_GOLD } from "./SignInWindow";

type Link = { userId: string; nonce: string };

const APPS: { name: string; open: (url: string) => string }[] = [
  { name: "MetaMask", open: (url) => `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}` },
  { name: "Coinbase Wallet", open: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  { name: "Trust Wallet", open: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
];

export function WalletAppLinks({
  getLink,
  walletCount,
  disabled,
  onLinked,
}: {
  /** A fresh one-time code (the signed-in player's verification nonce). */
  getLink: () => Promise<Link>;
  walletCount: number;
  disabled?: boolean;
  onLinked: () => void;
}) {
  const qc = useQueryClient();
  const [link, setLink] = useState<Link | null>(null);
  const [waiting, setWaiting] = useState(false);
  const startCount = useRef(walletCount);

  // Prepared as the window opens, so the tap itself can open the wallet app straight away (iPhone needs that).
  useEffect(() => {
    if (disabled) return;
    let live = true;
    getLink().then((l) => live && setLink(l), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // After the wallet app: look for the new wallet when the player comes back, and every few seconds meanwhile.
  useEffect(() => {
    if (!waiting) return;
    const check = () => void qc.invalidateQueries();
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    const t = window.setInterval(check, 4000);
    const stop = window.setTimeout(() => setWaiting(false), 15 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [waiting, qc]);
  useEffect(() => {
    if (waiting && walletCount > startCount.current) {
      setWaiting(false);
      toast.success("Wallet added");
      onLinked();
    }
  }, [waiting, walletCount, onLinked]);

  const url = link
    ? `${window.location.origin}/link-wallet?u=${encodeURIComponent(link.userId)}&n=${encodeURIComponent(link.nonce)}`
    : "";
  const go = (app: (typeof APPS)[number]) => {
    if (!url) return;
    startCount.current = walletCount;
    setWaiting(true);
    window.location.href = app.open(url);
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      startCount.current = walletCount;
      setWaiting(true);
      toast.success("Link copied: open it in your wallet app's browser");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border p-3 text-left">
      <p className="text-sm font-bold">On a phone? Add it from your wallet app</p>
      <p className="text-xs text-muted-foreground">
        Opens this site in your wallet app's browser, where the wallet signs a free message. Works when the button above
        can't reach your wallet.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {APPS.map((a) => (
          <button
            key={a.name}
            type="button"
            disabled={disabled || !url}
            onClick={() => go(a)}
            className="min-h-11 rounded-lg border px-2 py-1 text-sm font-bold transition hover:bg-white/5 disabled:opacity-60"
            style={{ borderColor: SIGN_IN_GOLD, color: SIGN_IN_GOLD }}
          >
            {a.name}
          </button>
        ))}
      </div>
      <button type="button" disabled={disabled || !url} onClick={() => void copy()} className="text-xs underline disabled:opacity-60">
        Another wallet app? Copy the link
      </button>
      {waiting && (
        <p className="text-xs text-primary">
          Sign in your wallet app, then come back here: the wallet appears by itself. (The link works once, for 15 minutes.)
        </p>
      )}
    </div>
  );
}
