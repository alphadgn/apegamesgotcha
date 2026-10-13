// The vendor's part of My account: a badge for value requests waiting, the "enter a winner's code" box for
// in-person redemptions, and value requests to pay in APE from their Glyph wallet (the certificate's issuer
// wallet). The APE amount is the certificate's dollar value at the APE price when they tap Pay; the payment is
// checked on ApeChain before the request is marked paid.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatEther } from "viem";
import { getMyVendor, vendorConfirmPayment, vendorListCertificates, vendorQuotePayment, vendorRedeemCode } from "@/lib/certificates.functions";
import { getGlyphSender, requestLinkWallet } from "@/components/wallet/walletUi";
import { confirmAction, ConfirmHost } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const VENDOR_QUERY_KEY = ["my-vendor"] as const;
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/** The signed-in player's vendor profile (null if they aren't a vendor), refreshed every minute for the badge. */
export function useMyVendor(enabled = true) {
  const fn = useServerFn(getMyVendor);
  return useQuery({ queryKey: VENDOR_QUERY_KEY, queryFn: () => fn(), enabled, staleTime: 30_000, refetchInterval: 60_000 });
}

/** Small red count used on the menu and the account page. */
export function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-bold text-white" aria-label={`${count} waiting`}>
      {count}
    </span>
  );
}

export function VendorArea() {
  const qc = useQueryClient();
  const { data: vendor } = useMyVendor();
  const listFn = useServerFn(vendorListCertificates);
  const redeemFn = useServerFn(vendorRedeemCode);
  const quoteFn = useServerFn(vendorQuotePayment);
  const confirmFn = useServerFn(vendorConfirmPayment);
  const { data: rows, refetch } = useQuery({ queryKey: ["vendor-certificates"], queryFn: () => listFn(), enabled: !!vendor, refetchInterval: 60_000 });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!vendor) return null;

  const toPay = (rows ?? []).filter((r) => r.status === "forwarded");
  const done = (rows ?? []).filter((r) => r.status !== "forwarded").slice(0, 20);
  const refresh = () => {
    void refetch();
    void qc.invalidateQueries({ queryKey: VENDOR_QUERY_KEY });
  };

  const redeem = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4) return void toast.error("Enter the winner's code");
    if (!(await confirmAction({ title: `Redeem code ${c}?`, description: "Use this only when the winner is with you: the certificate is used up.", confirmLabel: "Redeem" }))) return;
    setBusy("code");
    try {
      const r = await redeemFn({ data: { code: c } });
      toast.success(`Redeemed: ${r.prize} ($${r.valueUsd}) for ${r.player}`);
      setCode("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** A payment already sent: ask ApeChain again (never pays twice). */
  const check = async (r: (typeof toPay)[number]) => {
    if (!r.pendingTx) return;
    setBusy(r.id);
    try {
      const c = await confirmFn({ data: { id: r.id, txHash: r.pendingTx } });
      if (c.state === "ok") toast.success(`Paid: $${r.valueUsd} in APE sent to ${r.player}`);
      else if (c.state === "pending") toast.info("Still waiting for ApeChain to confirm the payment. Try again in a minute.");
      else toast.error(`${c.reason} You can pay again now.`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pay = async (r: (typeof toPay)[number]) => {
    setBusy(r.id);
    try {
      const sender = await getGlyphSender();
      if (!sender?.address) {
        toast.error("Connect your Glyph wallet first: Add wallet → Link Glyph wallet. Then tap Pay again.");
        requestLinkWallet();
        return;
      }
      if (r.issuerWallet && sender.address !== r.issuerWallet.toLowerCase())
        throw new Error(`Pay from the certificate's issuer wallet ${short(r.issuerWallet)}. Your Glyph wallet is ${short(sender.address)}. Ask an admin to update the issuer wallet if it changed.`);
      const q = await quoteFn({ data: { id: r.id } });
      const ape = Number(formatEther(BigInt(q.valueWei))).toFixed(4);
      if (
        !(await confirmAction({
          title: `Pay ${r.player} $${q.valueUsd} in APE?`,
          description: `${ape} APE (at $${Number(q.rate).toFixed(4)} per APE right now) goes from your Glyph wallet ${short(sender.address)} to ${short(q.to)}. Glyph asks you to approve it.`,
          confirmLabel: `Pay ${ape} APE`,
        }))
      )
        return;
      const hash = await sender.send({ to: q.to, value: BigInt(q.valueWei), chainId: q.chainId });
      toast.loading("Payment sent: waiting for ApeChain to confirm…", { id: `pay-${r.id}` });
      for (let i = 0; i < 40; i++) {
        const c = await confirmFn({ data: { id: r.id, txHash: hash } });
        if (c.state === "ok") {
          toast.success(`Paid: $${q.valueUsd} in APE sent to ${r.player}`, { id: `pay-${r.id}` });
          refresh();
          return;
        }
        if (c.state === "invalid") throw new Error(c.reason);
        await new Promise((res) => setTimeout(res, 3000));
      }
      toast.info("ApeChain is slow to confirm. The payment is sent: tap “Check payment” in a minute (don't pay again).", { id: `pay-${r.id}` });
      refresh();
    } catch (e) {
      const m = (e as Error).message ?? "Payment failed";
      toast.error(/reject|denied|cancel/i.test(m) ? "Payment cancelled." : m, { id: `pay-${r.id}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-primary/60 p-4 text-left">
      <ConfirmHost />
      <h2 className="flex items-center text-xl font-bold">
        Vendor: {vendor.businessName}
        <Badge count={vendor.waiting} />
      </h2>
      {vendor.location && <p className="text-sm text-muted-foreground">{vendor.location}</p>}

      <div className="mt-4">
        <h3 className="font-bold">Redeem a gift certificate in person</h3>
        <p className="text-sm text-muted-foreground">Ask the winner for their one-time code and enter it here.</p>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void redeem();
          }}
        >
          <Input
            className="font-mono uppercase tracking-widest"
            placeholder="CODE"
            value={code}
            maxLength={12}
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" disabled={busy === "code"}>
            {busy === "code" ? "…" : "Redeem"}
          </Button>
        </form>
      </div>

      <div className="mt-6">
        <h3 className="flex items-center font-bold">
          Value requests to pay <Badge count={toPay.length} />
        </h3>
        <p className="text-sm text-muted-foreground">
          Winners who chose the value. Pay each one in APE from your Glyph wallet: the amount is the certificate's dollar value at
          the APE price when you tap Pay.
        </p>
        {!toPay.length && <p className="mt-2 text-sm text-muted-foreground">Nothing waiting.</p>}
        <ul className="mt-2 divide-y divide-border text-sm">
          {toPay.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="font-bold">
                  {r.prize} · ${r.valueUsd}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {r.player} · to {short(r.payoutWallet)} · from {short(r.issuerWallet)}
                </p>
              </div>
              {r.pendingTx ? (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void check(r)}>
                  {busy === r.id ? "Checking…" : "Payment sent · Check payment"}
                </Button>
              ) : (
                <Button size="sm" disabled={!!busy} onClick={() => void pay(r)}>
                  {busy === r.id ? "Paying…" : `Pay $${r.valueUsd} in APE`}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {done.length > 0 && (
        <div className="mt-6">
          <h3 className="font-bold">Recently completed</h3>
          <ul className="mt-2 divide-y divide-border text-sm">
            {done.map((r) => (
              <li key={r.id} className="py-2 text-xs text-muted-foreground">
                <b className="text-foreground">{r.prize}</b> · ${r.valueUsd} · {r.player} ·{" "}
                {r.status === "paid" ? (
                  <>
                    paid {r.apeWei ? `${Number(formatEther(BigInt(r.apeWei))).toFixed(4)} APE` : ""}{" "}
                    {r.payTx && (
                      <a className="underline" href={r.payTx} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    )}
                  </>
                ) : (
                  "redeemed in person"
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
