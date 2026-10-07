import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, defineChain, formatEther, http, parseEther, type Hex } from "viem";
import { confirmSpinPurchase, createSpinPurchase, getSpinPriceQuote } from "@/lib/app.functions";
import { Button } from "@/components/ui/button";

export type PurchaseSettings = {
  enabled: boolean;
  chain_id: number;
  rpc_url: string;
  explorer_url?: string;
  treasury: string;
  price_ape_per_spin: string;
  price_usd_per_spin?: string;
  bundles?: number[];
  privy_app_id?: string;
};

/** What the checkout needs from a wallet, whichever kind it is (Privy or a browser extension). */
export type WalletAdapter = {
  ready: boolean;
  address: string | null;
  label: string; // e.g. "Privy wallet", "MetaMask"
  connect: () => Promise<void> | void;
  disconnect?: () => Promise<void> | void;
  pay: (tx: { to: string; valueWei: string; data: Hex; chainId: number }) => Promise<Hex>;
};

type Step =
  | { kind: "choose" }
  | { kind: "wallet" } // waiting for the wallet to sign
  | { kind: "confirming"; hash: Hex }
  | { kind: "done"; quantity: number }
  | { kind: "error"; message: string };

const PENDING_KEY = "gm-pending-purchase";
type PendingPurchase = { purchaseId: string; txHash: Hex; quantity: number };

export function readPendingPurchase(): PendingPurchase | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingPurchase) : null;
  } catch {
    return null;
  }
}
function savePending(p: PendingPurchase | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable */
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Confirm a payment until ApeChain has it (used by the modal and to resume after a reload). */
export function usePurchaseConfirmer() {
  const confirmFn = useServerFn(confirmSpinPurchase);
  return useCallback(
    async (p: PendingPurchase, isCancelled: () => boolean = () => false) => {
      const deadline = Date.now() + 5 * 60_000;
      while (!isCancelled() && Date.now() < deadline) {
        const r = await confirmFn({ data: { purchaseId: p.purchaseId, txHash: p.txHash } });
        if (r.status === "paid") {
          savePending(null);
          return r.quantity;
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
      return null;
    },
    [confirmFn],
  );
}

export function CheckoutPanel({ settings, wallet, onPurchased }: { settings: PurchaseSettings; wallet: WalletAdapter; onPurchased: (quantity: number) => void }) {
  const bundles = (settings.bundles?.length ? settings.bundles : [5, 10, 15, 20]).filter((n) => n % 5 === 0 && n <= 20);
  const [quantity, setQuantity] = useState(bundles[0] ?? 5);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [balance, setBalance] = useState<bigint | null>(null);
  const createFn = useServerFn(createSpinPurchase);
  const quoteFn = useServerFn(getSpinPriceQuote);
  const { data: quote, error: quoteError } = useQuery({ queryKey: ["spin-price-quote"], queryFn: () => quoteFn(), refetchInterval: 30_000, staleTime: 15_000 });
  const [approvedPayment, setApprovedPayment] = useState<{ eachWei: string; quotedAt: string } | null>(null);
  const confirm = usePurchaseConfirmer();
  const cancelled = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  const each = (() => {
    if (settings.price_usd_per_spin) return BigInt((approvedPayment ?? quote)?.eachWei ?? "0");
    try {
      return parseEther(String(settings.price_ape_per_spin || "0"));
    } catch {
      return 0n;
    }
  })();
  const total = each * BigInt(quantity);

  // Show the connected wallet's APE balance on ApeChain.
  useEffect(() => {
    setBalance(null);
    if (!wallet.address) return;
    const chain = defineChain({ id: settings.chain_id, name: "ApeChain", nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 }, rpcUrls: { default: { http: [settings.rpc_url] } } });
    const client = createPublicClient({ chain, transport: http(settings.rpc_url) });
    let live = true;
    client
      .getBalance({ address: wallet.address as Hex })
      .then((b) => live && setBalance(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wallet.address, settings.chain_id, settings.rpc_url, step.kind]);

  // Resume a payment that was still confirming when the modal or page closed.
  useEffect(() => {
    const pending = readPendingPurchase();
    if (!pending) return;
    setStep({ kind: "confirming", hash: pending.txHash });
    void confirm(pending, () => cancelled.current).then((q) => {
      if (cancelled.current) return;
      if (q) {
        setStep({ kind: "done", quantity: q });
        onPurchased(q);
      } else setStep({ kind: "error", message: "Still waiting for ApeChain to confirm your payment. Reopen this window in a minute to check again." });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pay = async () => {
    if (!wallet.address) return;
    setStep({ kind: "wallet" });
    try {
      const p = await createFn({ data: { quantity } });
      const shown = quote?.eachWei;
      if (settings.price_usd_per_spin && (!shown || BigInt(p.valueWei) !== BigInt(shown) * BigInt(quantity))) {
        setStep({ kind: "error", message: "The APE exchange rate changed. Check the updated amount and try again." });
        setApprovedPayment({ eachWei: (BigInt(p.valueWei) / BigInt(quantity)).toString(), quotedAt: new Date().toISOString() });
        return;
      }
      const hash = await wallet.pay({ to: p.to, valueWei: p.valueWei, data: p.data as Hex, chainId: p.chainId });
      const pending = { purchaseId: p.purchaseId, txHash: hash, quantity };
      savePending(pending); // so the spins are still credited if this window closes
      setStep({ kind: "confirming", hash });
      const q = await confirm(pending, () => cancelled.current);
      if (cancelled.current) return;
      if (q) {
        setStep({ kind: "done", quantity: q });
        onPurchased(q);
      } else setStep({ kind: "error", message: "Still waiting for ApeChain to confirm your payment. Your spins will be added once it confirms — reopen Refill to check." });
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? "Payment failed";
      setStep({ kind: "error", message: /reject|denied|cancel/i.test(msg) ? "Payment cancelled in your wallet." : msg });
    }
  };

  const txLink = (hash: string) => (settings.explorer_url ? `${settings.explorer_url.replace(/\/$/, "")}/tx/${hash}` : undefined);
  const short4 = (wei: bigint) => {
    const s = formatEther(wei);
    return s.includes(".") ? s.replace(/(\.\d{0,4}).*$/, "$1").replace(/\.$/, "") : s;
  };
  const insufficient = balance != null && balance < total;

  if (step.kind === "done") {
    return (
      <div className="gm-rf-done">
        <div className="gm-rf-big">+{step.quantity}</div>
        <p>spins added to your machine</p>
      </div>
    );
  }

  return (
    <div className="gm-rf">
      <p className="gm-rf-label">How many spins?</p>
      <div className="gm-rf-bundles" role="radiogroup" aria-label="Number of spins">
        {bundles.map((n) => (
          <Button
            key={n}
            type="button"
            role="radio"
            aria-checked={quantity === n}
            className={`gm-rf-bundle${quantity === n ? " is-on" : ""}`}
            disabled={step.kind === "wallet" || step.kind === "confirming"}
            onClick={() => setQuantity(n)}
          >
            <b>{n}</b>
            <small>{short4(each * BigInt(n))} APE</small>
          </Button>
        ))}
      </div>
      <p className="gm-rf-note">
        {settings.price_usd_per_spin ? `$${settings.price_usd_per_spin} USD per spin · $${Number(settings.price_usd_per_spin) * quantity} USD total in APE` : `${settings.price_ape_per_spin} APE per spin`} · paid on ApeChain · network fees extra
      </p>
      {settings.price_usd_per_spin && quoteError && <p className="gm-rf-error">Live APE pricing is unavailable. Please try again.</p>}

      <div className="gm-rf-wallet">
        {wallet.address ? (
          <>
            <span>
              {wallet.label} <b>{short(wallet.address)}</b>
              {balance != null && <em> · {short4(balance)} APE</em>}
            </span>
            {wallet.disconnect && step.kind === "choose" && (
              <button type="button" className="gm-rf-link" onClick={() => void wallet.disconnect?.()}>
                Switch
              </button>
            )}
          </>
        ) : (
          <span>No wallet connected</span>
        )}
      </div>
      {insufficient && wallet.address && (
        <p className="gm-rf-warn">
          This wallet needs {short4(total)} APE on ApeChain. Send APE to <b>{short(wallet.address)}</b>, then try again.
        </p>
      )}

      {step.kind === "error" && <p className="gm-rf-error">{step.message}</p>}
      {step.kind === "confirming" && (
        <p className="gm-rf-status">
          Confirming on ApeChain…{" "}
          {txLink(step.hash) && (
            <a href={txLink(step.hash)} target="_blank" rel="noreferrer">
              View payment ↗
            </a>
          )}
        </p>
      )}

      {!wallet.address ? (
        <Button type="button" className="gm-rf-cta" disabled={!wallet.ready} onClick={() => void wallet.connect()}>
          {wallet.ready ? "Connect wallet" : "Loading wallet…"}
        </Button>
      ) : (
        <Button
          type="button"
          className="gm-rf-cta"
          disabled={step.kind === "wallet" || step.kind === "confirming" || insufficient || total === 0n}
          onClick={() => void pay()}
        >
          {step.kind === "wallet" ? "Approve in your wallet…" : step.kind === "confirming" ? "Confirming…" : `Pay ${short4(total)} APE · ${quantity} spins`}
        </Button>
      )}
    </div>
  );
}
