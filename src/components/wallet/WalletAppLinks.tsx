// "Add wallet" on a phone, without WalletConnect: opens this site inside the wallet app's own browser
// (MetaMask, Coinbase Wallet, Trust), where the wallet signs the verification message on /link-wallet.
// The link carries a one-time code (the account's fresh verification nonce, valid 15 minutes).
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SIGN_IN_GOLD } from "./SignInWindow";
import { linkWalletWithCode } from "@/lib/app.functions";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

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

  // A browser that already has a wallet (computer extension, or this page opened inside a wallet app):
  // sign right here instead of switching apps.
  const injected =
    typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;
  const [signing, setSigning] = useState(false);
  const signHere = async () => {
    if (!injected || !link) return;
    setSigning(true);
    try {
      const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error("No wallet account was shared.");
      const message = `ApeGames Gotcha wallet verification\nUser: ${link.userId}\nNonce: ${link.nonce}`;
      const signature = (await injected.request({ method: "personal_sign", params: [message, address] })) as string;
      await linkWalletWithCode({ data: { userId: link.userId, nonce: link.nonce, address, signature } });
      toast.success("Wallet added");
      onLinked();
    } catch (e) {
      const m = (e as { message?: string })?.message ?? "Something went wrong";
      toast.error(/reject|denied|cancel/i.test(m) ? "Signature cancelled, so the wallet wasn't added." : m);
      getLink().then(setLink, () => undefined); // a fresh one-time code for the next try
    } finally {
      setSigning(false);
    }
  };

  const btn =
    "min-h-12 w-full rounded-lg border px-3 py-2 text-base font-bold transition hover:bg-white/5 disabled:cursor-default disabled:opacity-60";
  return (
    <>
      {APPS.map((a) => (
        <button
          key={a.name}
          type="button"
          disabled={disabled || !url || signing}
          onClick={() => (injected ? void signHere() : go(a))}
          className={btn}
          style={{ borderColor: SIGN_IN_GOLD, color: SIGN_IN_GOLD }}
        >
          {signing ? "Approve in your wallet…" : a.name}
        </button>
      ))}
      {!injected && (
        <button
          type="button"
          disabled={disabled || !url}
          onClick={() => void copy()}
          className="text-center text-xs underline disabled:opacity-60"
        >
          Another wallet app? Copy the link
        </button>
      )}
      {waiting && (
        <p className="text-center text-xs text-primary">
          Approve in your wallet app, then come back here: the wallet appears by itself. (The link works once, for 15
          minutes.)
        </p>
      )}
    </>
  );
}
