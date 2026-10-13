// Paying the shipping for an IRL prize: the dollar amount in APE at the live price, from the winner's Glyph wallet
// to the ApeGames treasury, checked on ApeChain. A sent-but-unconfirmed payment is remembered on the server, so
// the button turns into "Check payment" instead of paying twice.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatEther } from "viem";
import { confirmShippingPayment, quoteShippingPayment } from "@/lib/shipping.functions";
import { getGlyphSender, requestLinkWallet } from "@/components/wallet/walletUi";
import { Button } from "@/components/ui/button";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ShippingPay({
  spinId,
  usd,
  carrier,
  service,
  pendingTx,
  onPaid,
  onLater,
}: {
  spinId: string;
  usd: string;
  carrier: string;
  service: string;
  pendingTx?: string | null;
  onPaid?: () => void;
  onLater?: () => void;
}) {
  const qc = useQueryClient();
  const quoteFn = useServerFn(quoteShippingPayment);
  const confirmFn = useServerFn(confirmShippingPayment);
  const [offer, setOffer] = useState<null | { to: string; valueWei: string; chainId: number; rate: string; from: string }>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const done = async () => {
    toast.success("Shipping paid. The team will mail your prize.", { id: `ship-${spinId}` });
    await qc.invalidateQueries({ queryKey: ["irl-prizes"] });
    onPaid?.();
  };

  /** Asks the server about a sent payment until ApeChain confirms it (about 2 minutes at most). */
  const watch = async (hash: string) => {
    toast.loading("Payment sent: waiting for ApeChain to confirm…", { id: `ship-${spinId}` });
    for (let i = 0; i < 40; i++) {
      const c = await confirmFn({ data: { spinId, txHash: hash } });
      if (c.state === "ok") return done();
      if (c.state === "invalid") throw new Error(c.reason);
      await new Promise((r) => setTimeout(r, 3000));
    }
    toast.info("ApeChain is slow to confirm. Your payment is sent: tap “Check payment” in a minute (don't pay again).", { id: `ship-${spinId}` });
    await qc.invalidateQueries({ queryKey: ["irl-prizes"] });
  };

  const start = async () => {
    setBusy("quote");
    try {
      const sender = await getGlyphSender();
      if (!sender?.address) {
        toast.error("Connect your Glyph wallet first (Add wallet → Link Glyph wallet), then tap Pay again.");
        requestLinkWallet();
        return;
      }
      const q = await quoteFn({ data: { spinId } });
      setOffer({ to: q.to, valueWei: q.valueWei, chainId: q.chainId, rate: q.rate, from: sender.address });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    if (!offer) return;
    setBusy("pay");
    try {
      const sender = await getGlyphSender();
      if (!sender?.address) throw new Error("Your Glyph wallet isn't connected.");
      const hash = await sender.send({ to: offer.to, value: BigInt(offer.valueWei), chainId: offer.chainId });
      setOffer(null);
      await watch(hash);
    } catch (e) {
      const m = (e as Error).message ?? "Payment failed";
      toast.error(/reject|denied|cancel/i.test(m) ? "Payment cancelled." : m, { id: `ship-${spinId}` });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!pendingTx) return;
    setBusy("check");
    try {
      await watch(pendingTx);
    } catch (e) {
      toast.error((e as Error).message, { id: `ship-${spinId}` });
      await qc.invalidateQueries({ queryKey: ["irl-prizes"] });
    } finally {
      setBusy(null);
    }
  };

  const ape = offer ? Number(formatEther(BigInt(offer.valueWei))).toFixed(4) : null;
  return (
    <div className="mt-3 rounded border border-primary bg-primary/10 p-3 text-sm">
      <p className="font-bold">Shipping: ${usd}</p>
      <p className="text-xs text-muted-foreground">
        {carrier} {service}. You pay the shipping in APE at the price right now; the team mails your prize once it's paid.
      </p>
      {pendingTx ? (
        <Button className="mt-2 w-full" disabled={!!busy} onClick={() => void check()}>
          {busy === "check" ? "Checking…" : "Check payment"}
        </Button>
      ) : offer ? (
        <div className="mt-2 space-y-2">
          <p>
            Pay <b>{ape} APE</b> (${usd} at ${Number(offer.rate).toFixed(4)} per APE) from your Glyph wallet {short(offer.from)} to the ApeGames
            treasury {short(offer.to)}? Glyph asks you to approve it.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button disabled={!!busy} onClick={() => void pay()}>
              {busy === "pay" ? "Approve in Glyph…" : `Pay ${ape} APE`}
            </Button>
            <Button variant="outline" disabled={!!busy} onClick={() => setOffer(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-2 w-full" disabled={!!busy} onClick={() => void start()}>
          {busy === "quote" ? "Getting the APE price…" : `Pay $${usd} shipping in APE`}
        </Button>
      )}
      {onLater && !offer && (
        <button type="button" className="mt-2 w-full text-center text-xs underline" onClick={onLater}>
          Pay later (from Your IRL prizes on My Machine)
        </button>
      )}
    </div>
  );
}
