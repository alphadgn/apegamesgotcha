// "Add wallet" with a phone wallet app, without WalletConnect: opens /link-wallet?c=<sealed one-time code> inside
// the wallet app's own browser (MetaMask, Coinbase Wallet, Trust), where the wallet signs and is linked to this
// signed-in player. The code is kept for its whole life (15 min) in this tab, so the window re-opening while the
// player is away in the wallet app can't swap it for a new one (that made the wallet app's link fail as
// "used or replaced", Oct 12). With a wallet already in this browser (computer extension, or inside a wallet
// app), the buttons sign right here instead.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SIGN_IN_GOLD } from "./SignInWindow";
import { checkWalletLink, describeWalletLink, getWalletLinkResult, linkWalletWithCode } from "@/lib/app.functions";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
export type WalletLinkCode = { code: string; expiresAt: string };

const APPS: { name: string; open: (url: string) => string }[] = [
  { name: "MetaMask", open: (url) => `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}` },
  { name: "Coinbase Wallet", open: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  { name: "Trust Wallet", open: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
];

const STORE = "gm-wallet-link-code";
/** Reuse this player's code while it has at least 2 minutes left. */
function storedCode(userId: string): WalletLinkCode | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE) ?? "null") as (WalletLinkCode & { userId: string }) | null;
    if (s && s.userId === userId && new Date(s.expiresAt).getTime() - Date.now() > 2 * 60_000) return s;
  } catch {
    /* storage unavailable */
  }
  return null;
}
function storeCode(userId: string, c: WalletLinkCode | null) {
  try {
    if (c) sessionStorage.setItem(STORE, JSON.stringify({ ...c, userId }));
    else sessionStorage.removeItem(STORE);
  } catch {
    /* storage unavailable */
  }
}

export function WalletAppLinks({
  userId,
  getCode,
  walletCount,
  disabled,
  onLinked,
}: {
  userId: string;
  /** A fresh sealed one-time code for the signed-in player. */
  getCode: () => Promise<WalletLinkCode>;
  walletCount: number;
  disabled?: boolean;
  onLinked: () => void;
}) {
  const qc = useQueryClient();
  const [link, setLink] = useState<WalletLinkCode | null>(() => (typeof window === "undefined" ? null : storedCode(userId)));
  const [waiting, setWaiting] = useState(false);
  const startCount = useRef(walletCount); // kept for the waiting state (the result itself comes from the server)

  // Ready before the tap, so the tap itself opens the wallet app (iPhone needs that).
  useEffect(() => {
    if (disabled || link) return;
    let live = true;
    getCode().then(
      (c) => {
        storeCode(userId, c);
        if (live) setLink(c);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, link, userId]);

  // After the wallet app: look for the new wallet when the player comes back, and every few seconds meanwhile.
  // What happened in the wallet app (added, or already linked — which doesn't change the wallet count).
  useEffect(() => {
    if (!waiting || !link) return;
    let live = true;
    const ask = async () => {
      const r = await getWalletLinkResult({ data: { code: link.code } }).catch(() => null);
      if (!live || !r) return;
      setWaiting(false);
      storeCode(userId, null);
      setLink(null);
      if (r.result === "already")
        toast.info(`Wallet ${r.address.slice(0, 6)}…${r.address.slice(-4)} is already linked to your account, so nothing changed.`);
      else toast.success("Wallet added");
      onLinked();
    };
    const onVisible = () => document.visibilityState === "visible" && void ask();
    document.addEventListener("visibilitychange", onVisible);
    const t = window.setInterval(() => void ask(), 4000);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, link]);

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


  const url = link ? `${window.location.origin}/link-wallet?c=${encodeURIComponent(link.code)}` : "";
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

  // A wallet already in this browser (computer extension, or this site opened inside a wallet app): sign here.
  const injected =
    typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;
  const [signing, setSigning] = useState(false);
  const signHere = async () => {
    if (!injected || !link) return;
    setSigning(true);
    try {
      const { message } = await describeWalletLink({ data: { code: link.code } });
      const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error("No wallet account was shared.");
      const { status } = await checkWalletLink({ data: { code: link.code, address } });
      if (status === "other") throw new Error("This wallet is already linked to another ApeGames Gotcha account.");
      if (status === "mine") {
        toast.info(`Wallet ${address.slice(0, 6)}…${address.slice(-4)} is already linked to your account, so nothing changed.`);
        return;
      }
      const signature = (await injected.request({ method: "personal_sign", params: [message, address] })) as string;
      const r = await linkWalletWithCode({ data: { code: link.code, address, signature } });
      storeCode(userId, null);
      setLink(null);
      if (r.alreadyLinked) toast.info("This wallet is already linked to your account, so nothing changed.");
      else toast.success("Wallet added");
      onLinked();
    } catch (e) {
      const m = (e as { message?: string })?.message ?? "Something went wrong";
      toast.error(/reject|denied|cancel/i.test(m) ? "Signature cancelled, so the wallet wasn't added." : m);
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
          Approve in your wallet app, then tap “Back to ApeGames Gotcha”. The wallet shows up here by itself.
        </p>
      )}
    </>
  );
}
