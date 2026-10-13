// "Your IRL prizes": physical prizes the player won in a real draw, each with its claim form and status.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { claimSchema, getMyIrlPrizes, submitPrizeClaim, type IrlWin } from "@/lib/claims.functions";
import { getShippingRates } from "@/lib/shipping.functions";
import { COUNTRIES } from "@/lib/countries";
import { ShippingPay } from "./ShippingPay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrizeImage } from "./PrizeImage";

export const IRL_QUERY_KEY = ["irl-prizes"] as const;

export function useMyIrlPrizes(enabled = true) {
  const fn = useServerFn(getMyIrlPrizes);
  return useQuery({ queryKey: IRL_QUERY_KEY, queryFn: () => fn(), enabled, staleTime: 30_000 });
}

export { PrizeImage };

const STATUS: Record<string, { label: string; tone: string; help: string }> = {
  none: { label: "Claim needed", tone: "bg-destructive/20 text-destructive", help: "Tell us how you'd like to receive it." },
  submitted: { label: "Claim received", tone: "bg-primary/20 text-primary", help: "The team will review it shortly. You can still edit it." },
  approved: { label: "Approved", tone: "bg-primary/20 text-primary", help: "Approved — we're getting it ready." },
  shipped: { label: "Shipped", tone: "bg-primary/20 text-primary", help: "On its way." },
  delivered: { label: "Delivered", tone: "bg-muted text-muted-foreground", help: "Delivered. Enjoy!" },
  rejected: { label: "Needs attention", tone: "bg-destructive/20 text-destructive", help: "The team couldn't complete this claim. Use the guide's Contact form." },
};

export function IrlPrizes() {
  const { data, isLoading } = useMyIrlPrizes();
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading || !data?.length) return null;
  return (
    <section id="irl" className="rounded border border-primary/60 bg-card p-4 text-left sm:p-6">
      <h2 className="text-xl font-bold">Your IRL prizes</h2>
      <p className="mt-1 text-sm text-muted-foreground">Real-world prizes you won in on-chain draws. Claim each one so the team can get it to you.</p>
      <ul className="mt-4 space-y-3">
        {data.map((w) => {
          const owes = !!w.claim && w.claim.delivery === "ship" && w.claim.ship_usd != null && !w.claim.ship_paid_at && w.claim.status !== "rejected";
          const st = owes ? { label: "Shipping not paid yet", tone: "bg-destructive/20 text-destructive", help: "Pay the shipping so the team can mail your prize." } : STATUS[w.claim?.status ?? "none"]!;
          return (
            <li key={w.spin_id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <PrizeImage path={w.image_path} alt={w.prize_name} className="h-16 w-16 shrink-0 rounded" />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{w.prize_name}</p>
                  <p className="text-xs text-muted-foreground">Won {new Date(w.won_at).toLocaleString()}</p>
                  <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.label}</span>
                </div>
                {(!w.claim || w.claim.status === "submitted") && (
                  <Button size="sm" variant={w.claim ? "outline" : "default"} onClick={() => setOpen(open === w.spin_id ? null : w.spin_id)}>
                    {open === w.spin_id ? "Close" : w.claim ? "Edit claim" : "Claim prize"}
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {st.help}
                {w.claim?.tracking ? ` Tracking: ${w.claim.tracking}` : ""}
                {w.claim?.admin_note ? ` Note from the team: ${w.claim.admin_note}` : ""}
              </p>
              {owes && open !== w.spin_id && (
                <ShippingPay
                  spinId={w.spin_id}
                  usd={w.claim!.ship_usd!}
                  carrier={w.claim!.ship_carrier ?? ""}
                  service={w.claim!.ship_service ?? ""}
                  pendingTx={w.claim!.ship_pending_tx}
                />
              )}
              {w.claim?.ship_paid_at && (
                <p className="mt-1 text-xs text-primary">
                  Shipping paid: {w.claim.ship_carrier} {w.claim.ship_service} (${w.claim.ship_usd}).
                </p>
              )}
              {open === w.spin_id && <ClaimForm win={w} onDone={() => setOpen(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Delivery details for one won prize (pick up at ApeFest or ship to an address). */
export function ClaimForm({ win, onDone, cancelLabel = "Cancel" }: { win: IrlWin; onDone: () => void; cancelLabel?: string }) {
  const qc = useQueryClient();
  const submit = useServerFn(submitPrizeClaim);
  const c = win.claim;
  const [f, setF] = useState({
    fullName: c?.full_name ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    delivery: (c?.delivery ?? "pickup") as "pickup" | "ship",
    line1: c?.address?.["line1"] ?? "",
    line2: c?.address?.["line2"] ?? "",
    city: c?.address?.["city"] ?? "",
    region: c?.address?.["region"] ?? "",
    postal: c?.address?.["postal"] ?? "",
    country: c?.address?.["country"] ?? "United States",
    notes: c?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const ADDRESS_KEYS = ["line1", "line2", "city", "region", "postal", "country"];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setF({ ...f, [k]: e.target.value });
    if (ADDRESS_KEYS.includes(k)) setQuote(null); // a new address needs a new shipping price
  };
  // Shipping: paid by the winner. Once paid (or on its way) the delivery and address are locked.
  const shipLocked = !!(c?.ship_paid_at || c?.ship_pending_tx);
  const ratesFn = useServerFn(getShippingRates);
  const [quote, setQuote] = useState<null | { quoteId: string; rates: { id: string; carrier: string; service: string; days: number | null; usd: string }[]; handlingUsd: string | null }>(null);
  const [rateId, setRateId] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);
  const [payStep, setPayStep] = useState<null | { usd: string; carrier: string; service: string }>(null);
  const address = { line1: f.line1, line2: f.line2, city: f.city, region: f.region, postal: f.postal, country: f.country };
  const calculate = async () => {
    setPricing(true);
    setQuote(null);
    setRateId(null);
    try {
      const q = await ratesFn({ data: { spinId: win.spin_id, fullName: f.fullName, email: f.email, phone: f.phone, address } });
      setQuote(q);
      setRateId(q.rates[0]?.id ?? null);
    } catch (err) {
      const m = (err as Error).message;
      toast.error(m.trim().startsWith("[") ? "Fill in your name, email and the full address first." : m);
    } finally {
      setPricing(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      spinId: win.spin_id,
      fullName: f.fullName,
      email: f.email,
      phone: f.phone,
      delivery: f.delivery,
      notes: f.notes,
      ...(f.delivery === "ship" ? { address } : {}),
      ...(f.delivery === "ship" && !shipLocked && quote && rateId ? { shipQuoteId: quote.quoteId, shipRateId: rateId } : {}),
    };
    if (f.delivery === "ship" && !shipLocked && (!quote || !rateId)) {
      toast.error("Calculate the shipping and pick a rate first.");
      return;
    }
    const parsed = claimSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    setBusy(true);
    try {
      const r = await submit({ data: parsed.data });
      await qc.invalidateQueries({ queryKey: IRL_QUERY_KEY });
      if (r.shipping && !r.shipping.paid) {
        toast.success("Claim saved. Last step: pay the shipping.");
        setPayStep(r.shipping);
        return;
      }
      toast.success(r.updated ? "Claim updated" : "Claim sent — the team will be in touch");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (payStep)
    return (
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-sm">Your claim is saved. Pay the shipping and the team mails your prize to {f.city}.</p>
        <ShippingPay spinId={win.spin_id} usd={payStep.usd} carrier={payStep.carrier} service={payStep.service} onPaid={onDone} onLater={onDone} />
      </div>
    );

  return (
    <form onSubmit={send} className="mt-3 grid gap-2 border-t border-border pt-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Full name" value={f.fullName} onChange={set("fullName")} maxLength={120} />
        <Input type="email" placeholder="Email for updates" value={f.email} onChange={set("email")} maxLength={255} />
        <Input type="tel" placeholder="Phone (optional)" value={f.phone} onChange={set("phone")} maxLength={40} />
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium">How do you want it?</legend>
        {(
          [
            ["pickup", "Pick up at ApeFest Charleston", "Collect it at the ApeGames area during the event."],
            ["ship", "Ship it to me", "We'll send it to the address below. You pay the shipping."],
          ] as const
        ).map(([v, label, help]) => (
          <label key={v} className={`flex cursor-pointer gap-2 rounded border p-3 text-sm ${f.delivery === v ? "border-primary bg-primary/10" : "border-border"}`}>
            <input type="radio" name={`delivery-${win.spin_id}`} className="mt-1 h-4 w-4 shrink-0" checked={f.delivery === v} disabled={shipLocked && v !== "ship"} onChange={() => setF({ ...f, delivery: v })} />
            <span>
              <b>{label}</b>
              <span className="block text-xs text-muted-foreground">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {f.delivery === "ship" && (
        <p className="rounded border border-primary/60 bg-primary/10 p-2 text-xs">
          <b>Note:</b> if you choose to have your prize mailed, you pay the shipping. Enter your address and tap “Calculate shipping”:
          we get live prices from the carriers for your address, you pick one, and you pay it in APE before the prize is mailed.
        </p>
      )}
      {f.delivery === "ship" && (
        <fieldset disabled={shipLocked} className="grid gap-2 sm:grid-cols-2">
          <Input className="sm:col-span-2" placeholder="Street address" value={f.line1} onChange={set("line1")} maxLength={200} />
          <Input className="sm:col-span-2" placeholder="Apartment, suite (optional)" value={f.line2} onChange={set("line2")} maxLength={200} />
          <Input placeholder="City" value={f.city} onChange={set("city")} maxLength={100} />
          <Input placeholder="State / region" value={f.region} onChange={set("region")} maxLength={100} />
          <Input placeholder="ZIP / postal code" value={f.postal} onChange={set("postal")} maxLength={20} />
          <select
            aria-label="Country"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={f.country}
            onChange={set("country")}
          >
            {!COUNTRIES.some(([, n]) => n === f.country) && <option value={f.country}>{f.country || "Country"}</option>}
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={name}>
                {name}
              </option>
            ))}
          </select>
        </fieldset>
      )}
      {f.delivery === "ship" && shipLocked && (
        <p className="text-xs text-primary">
          Shipping {c?.ship_paid_at ? "paid" : "payment on its way"}: {c?.ship_carrier} {c?.ship_service} (${c?.ship_usd}). The address can't change here now.
        </p>
      )}
      {f.delivery === "ship" && !shipLocked && (
        <div className="rounded border border-border p-3">
          <Button type="button" variant="outline" className="w-full" disabled={pricing} onClick={() => void calculate()}>
            {pricing ? "Getting live shipping prices…" : quote ? "Calculate shipping again" : "Calculate shipping"}
          </Button>
          {quote && (
            <div className="mt-3 space-y-1" role="radiogroup" aria-label="Shipping rate">
              <p className="text-xs text-muted-foreground">
                Pick how it ships{quote.handlingUsd ? ` (prices include $${quote.handlingUsd} packing & handling)` : ""}:
              </p>
              {quote.rates.map((r) => (
                <label key={r.id} className={`flex cursor-pointer items-center gap-2 rounded border p-2 text-sm ${rateId === r.id ? "border-primary bg-primary/10" : "border-border"}`}>
                  <input type="radio" name={`rate-${win.spin_id}`} checked={rateId === r.id} onChange={() => setRateId(r.id)} />
                  <span className="min-w-0 flex-1">
                    <b>{r.carrier}</b> {r.service}
                    {r.days ? <span className="text-xs text-muted-foreground"> · about {r.days} day{r.days === 1 ? "" : "s"}</span> : null}
                  </span>
                  <b>${r.usd}</b>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <textarea
        className="min-h-20 w-full rounded border border-input bg-background px-3 py-2 text-sm"
        placeholder="Anything we should know? (size, best time to pick up…)"
        value={f.notes}
        onChange={set("notes")}
        maxLength={1000}
      />
      <p className="text-xs text-muted-foreground">Your details are only shared with the ApeGames team to deliver this prize.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>{cancelLabel}</Button>
        <Button type="submit" disabled={busy}>{busy ? "Sending…" : c ? "Update claim" : "Send claim"}</Button>
      </div>
    </form>
  );
}
