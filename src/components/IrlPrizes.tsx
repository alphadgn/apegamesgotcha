// "Your IRL prizes": physical prizes the player won in a real draw, each with its claim form and status.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { claimSchema, getMyIrlPrizes, submitPrizeClaim, type IrlWin } from "@/lib/claims.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const IRL_QUERY_KEY = ["irl-prizes"] as const;

export function useMyIrlPrizes(enabled = true) {
  const fn = useServerFn(getMyIrlPrizes);
  return useQuery({ queryKey: IRL_QUERY_KEY, queryFn: () => fn(), enabled, staleTime: 30_000 });
}

/** A prize picture from the private prize-images bucket, shown through a short-lived signed link. */
export function PrizeImage({ path, alt, className = "" }: { path: string | null; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (path)
      void supabase.storage
        .from("prize-images")
        .createSignedUrl(path, 3600)
        .then(({ data }) => live && setUrl(data?.signedUrl ?? null));
    return () => {
      live = false;
    };
  }, [path]);
  if (!url) return <div className={`flex items-center justify-center bg-muted text-2xl ${className}`} aria-hidden>🎁</div>;
  return <img src={url} alt={alt} className={`object-cover ${className}`} />;
}

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
          const st = STATUS[w.claim?.status ?? "none"]!;
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
              {open === w.spin_id && <ClaimForm win={w} onDone={() => setOpen(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClaimForm({ win, onDone }: { win: IrlWin; onDone: () => void }) {
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
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      spinId: win.spin_id,
      fullName: f.fullName,
      email: f.email,
      phone: f.phone,
      delivery: f.delivery,
      notes: f.notes,
      ...(f.delivery === "ship" ? { address: { line1: f.line1, line2: f.line2, city: f.city, region: f.region, postal: f.postal, country: f.country } } : {}),
    };
    const parsed = claimSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    setBusy(true);
    try {
      const r = await submit({ data: parsed.data });
      toast.success(r.updated ? "Claim updated" : "Claim sent — the team will be in touch");
      await qc.invalidateQueries({ queryKey: IRL_QUERY_KEY });
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
            ["ship", "Ship it to me", "We'll send it to the address below."],
          ] as const
        ).map(([v, label, help]) => (
          <label key={v} className={`flex cursor-pointer gap-2 rounded border p-3 text-sm ${f.delivery === v ? "border-primary bg-primary/10" : "border-border"}`}>
            <input type="radio" name={`delivery-${win.spin_id}`} className="mt-1 h-4 w-4 shrink-0" checked={f.delivery === v} onChange={() => setF({ ...f, delivery: v })} />
            <span>
              <b>{label}</b>
              <span className="block text-xs text-muted-foreground">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {f.delivery === "ship" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input className="sm:col-span-2" placeholder="Street address" value={f.line1} onChange={set("line1")} maxLength={200} />
          <Input className="sm:col-span-2" placeholder="Apartment, suite (optional)" value={f.line2} onChange={set("line2")} maxLength={200} />
          <Input placeholder="City" value={f.city} onChange={set("city")} maxLength={100} />
          <Input placeholder="State / region" value={f.region} onChange={set("region")} maxLength={100} />
          <Input placeholder="ZIP / postal code" value={f.postal} onChange={set("postal")} maxLength={20} />
          <Input placeholder="Country" value={f.country} onChange={set("country")} maxLength={60} />
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
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? "Sending…" : c ? "Update claim" : "Send claim"}</Button>
      </div>
    </form>
  );
}
