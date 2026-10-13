// Admin → Gift certificates (every admin) and Admin → Vendors (super admin only). See certificates.functions.ts.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  adminCertificatePrizes,
  adminForwardCertificate,
  adminListCertificates,
  adminSetCertificatePrize,
  superListVendors,
  superRemoveVendor,
  superSetVendor,
  type CertStatus,
} from "@/lib/certificates.functions";
import { superListAccounts } from "@/lib/users.functions";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

const STATUS: Record<CertStatus, string> = {
  unclaimed: "Winner hasn't chosen",
  code_issued: "In person: code issued",
  redeemed: "Redeemed in person",
  requested: "Value requested",
  forwarded: "Sent to vendor",
  paid: "Paid in APE",
  cancelled: "Cancelled",
};

// ---------- Gift certificates ----------

export function GiftCertificatesPanel() {
  const list = useServerFn(adminListCertificates);
  const forward = useServerFn(adminForwardCertificate);
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["admin-certificates"], queryFn: () => list(), refetchInterval: 60_000 });
  const [view, setView] = useState<"requests" | "all">("requests");
  const [busy, setBusy] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  const requests = rows.filter((r) => r.status === "requested");
  const shown = view === "requests" ? requests : rows;

  const doForward = async (r: (typeof rows)[number]) => {
    if (
      !(await confirmAction({
        title: `Send this request to ${r.vendor}?`,
        description: `${r.player} asked for the value of "${r.prize}": $${r.valueUsd} in APE to ${short(r.payoutWallet)}. ${r.vendor} gets a notification on their account page and pays from the issuer wallet.`,
        confirmLabel: "Send to vendor",
      }))
    )
      return;
    setBusy(r.id);
    try {
      await forward({ data: { id: r.id } });
      toast.success(`Sent to ${r.vendor}`);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 space-y-4 text-left">
      <CertificatePrizesCard />
      <div className="rounded border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Certificates won</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={view === "requests" ? "default" : "outline"} onClick={() => setView("requests")}>
              Value requests ({requests.length})
            </Button>
            <Button size="sm" variant={view === "all" ? "default" : "outline"} onClick={() => setView("all")}>
              All ({rows.length})
            </Button>
            <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? "…" : "Refresh"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Winners choose to redeem in person (they show a one-time code the vendor enters) or to claim the value. Value requests wait
          here: send each one to its vendor, who pays the dollar value in APE to the winner from the issuer wallet.
        </p>
        {data && !data.ready && <p className="mt-2 text-sm text-destructive">Gift certificates turn on after the database update (0019).</p>}
        {error && <p className="mt-2 text-sm text-destructive">{(error as Error).message}</p>}
        {data && !shown.length && <p className="mt-3 text-sm text-muted-foreground">Nothing here.</p>}
        <ul className="mt-3 divide-y divide-border text-sm">
          {shown.map((r) => (
            <li key={r.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="font-bold">
                  {r.prize} · ${r.valueUsd}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {r.player} · {r.vendor} · won {new Date(r.wonAt).toLocaleDateString()}
                  {r.payoutWallet ? ` · pay to ${short(r.payoutWallet)}` : ""}
                  {r.payTx && (
                    <>
                      {" · "}
                      <a className="underline" href={r.payTx} target="_blank" rel="noreferrer">
                        payment ↗
                      </a>
                    </>
                  )}
                </p>
                <span className="mt-1 inline-block rounded bg-muted px-2 py-0.5 text-xs font-bold">{STATUS[r.status]}</span>
              </div>
              {r.status === "requested" &&
                (r.hasVendor ? (
                  <Button size="sm" disabled={busy === r.id} onClick={() => void doForward(r)}>
                    {busy === r.id ? "Sending…" : "Send to vendor"}
                  </Button>
                ) : (
                  <span className="text-xs text-destructive">Set this certificate's vendor first</span>
                ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Which prizes are gift certificates: dollar value, issuing vendor and the issuer wallet that pays out. */
function CertificatePrizesCard() {
  const load = useServerFn(adminCertificatePrizes);
  const save = useServerFn(adminSetCertificatePrize);
  const { data, refetch } = useQuery({ queryKey: ["admin-cert-prizes"], queryFn: () => load() });
  const [edit, setEdit] = useState<{ prizeId: string; value: string; vendorId: string; wallet: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const vendors = data?.vendors ?? [];

  const submit = async (makeCert: boolean) => {
    if (!edit) return;
    const prize = data?.prizes.find((p) => p.id === edit.prizeId);
    const value = Number(edit.value);
    if (makeCert && (!(value > 0) || !edit.vendorId || !isAddr(edit.wallet)))
      return void toast.error("Enter a dollar value, pick the vendor, and enter the issuer's wallet address (0x…).");
    const vendor = vendors.find((v) => v.id === edit.vendorId);
    if (
      !(await confirmAction(
        makeCert
          ? {
              title: `Make "${prize?.name}" a $${value.toFixed(2)} gift certificate?`,
              description: `Issued by ${vendor?.name}. Value payouts must come from ${short(edit.wallet)}. Winners from now on get this certificate.`,
              confirmLabel: "Save",
            }
          : { title: `Make "${prize?.name}" a normal prize again?`, description: "Certificates already won keep their value and vendor.", confirmLabel: "Save" },
      ))
    )
      return;
    setBusy(true);
    try {
      await save({
        data: {
          prizeId: edit.prizeId,
          valueUsd: makeCert ? value : null,
          vendorId: makeCert ? edit.vendorId : null,
          issuerWallet: makeCert ? edit.wallet.trim() : null,
        },
      });
      toast.success("Saved");
      setEdit(null);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-border bg-card p-4">
      <h3 className="font-bold">Gift certificate prizes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Turn a prize into a gift certificate: its dollar value, the vendor who issues it, and the issuer wallet that pays out when a
        winner claims the value. (Odds, stock and the prize itself stay in Prizes & odds.)
        {!vendors.length && " Promote a vendor first (super admin → Vendors)."}
      </p>
      {data && !data.ready && <p className="mt-2 text-sm text-destructive">Gift certificates turn on after the database update (0019).</p>}
      <ul className="mt-3 divide-y divide-border text-sm">
        {(data?.prizes ?? []).map((p) => {
          const v = vendors.find((x) => x.id === p.vendorId);
          const editing = edit?.prizeId === p.id;
          return (
            <li key={p.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold">
                    {p.name} <span className="text-xs uppercase text-muted-foreground">{p.rarity}{p.active ? "" : " · off"}</span>
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {p.valueUsd ? `🎟️ $${p.valueUsd} certificate · ${v?.name ?? "vendor removed"} · issuer ${short(p.issuerWallet)}` : "Not a certificate"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setEdit(
                      editing
                        ? null
                        : { prizeId: p.id, value: p.valueUsd ?? "", vendorId: p.vendorId ?? vendors[0]?.id ?? "", wallet: p.issuerWallet ?? v?.wallet ?? vendors[0]?.wallet ?? "" },
                    )
                  }
                >
                  {editing ? "Cancel" : p.valueUsd ? "Edit" : "Make certificate"}
                </Button>
              </div>
              {editing && edit && (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <label className="text-xs text-muted-foreground">
                    Value (USD)
                    <Input className="mt-1" inputMode="decimal" placeholder="100" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    Vendor
                    <select
                      className="mt-1 h-10 w-full rounded border border-border bg-background px-2 text-sm text-foreground"
                      value={edit.vendorId}
                      onChange={(e) => {
                        const nv = vendors.find((x) => x.id === e.target.value);
                        setEdit({ ...edit, vendorId: e.target.value, wallet: edit.wallet || nv?.wallet || "" });
                      }}
                    >
                      <option value="">Pick a vendor…</option>
                      {vendors.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted-foreground">
                    Issuer wallet (pays out the value)
                    <Input className="mt-1 font-mono" placeholder="0x…" value={edit.wallet} onChange={(e) => setEdit({ ...edit, wallet: e.target.value })} />
                  </label>
                  <div className="flex flex-wrap gap-2 sm:col-span-3">
                    <Button size="sm" disabled={busy} onClick={() => void submit(true)}>
                      Save certificate
                    </Button>
                    {p.valueUsd && (
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void submit(false)}>
                        Make it a normal prize
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Vendors (super admin) ----------

export function VendorsPanel() {
  const list = useServerFn(superListVendors);
  const setVendor = useServerFn(superSetVendor);
  const remove = useServerFn(superRemoveVendor);
  const accounts = useServerFn(superListAccounts);
  const { data, refetch } = useQuery({ queryKey: ["vendors"], queryFn: () => list() });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { data: found, isFetching } = useQuery({
    queryKey: ["vendor-candidates", search],
    queryFn: () => accounts({ data: { query: search } }),
    enabled: search.length > 0,
  });
  const [form, setForm] = useState<{ userId: string; who: string; name: string; location: string; wallet: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const vendorIds = new Set((data?.rows ?? []).map((v) => v.user_id));

  useEffect(() => {
    if (form) window.setTimeout(() => document.getElementById("vendor-form")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }, [form?.userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!form) return;
    if (form.name.trim().length < 2) return void toast.error("Enter the business name");
    if (form.wallet && !isAddr(form.wallet)) return void toast.error("That wallet address isn't valid (0x + 40 characters)");
    const isNew = !vendorIds.has(form.userId);
    if (
      !(await confirmAction({
        title: isNew ? `Promote ${form.who} to vendor?` : `Save ${form.name}?`,
        description: isNew
          ? `${form.who} becomes the vendor "${form.name}". They'll see value requests (with a badge) on their account page, can pay them in APE, and enter winners' in-person codes.`
          : "Updates the business details.",
        confirmLabel: isNew ? "Promote to vendor" : "Save",
      }))
    )
      return;
    setBusy(true);
    try {
      await setVendor({ data: { userId: form.userId, businessName: form.name, location: form.location.trim() || null, wallet: form.wallet.trim() || null } });
      toast.success(isNew ? "Promoted to vendor" : "Saved");
      setForm(null);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const demote = async (v: { user_id: string; business_name: string; username: string }) => {
    if (
      !(await confirmAction({
        title: `Remove ${v.business_name} as a vendor?`,
        description: `${v.username} goes back to a regular player. Certificates already won keep their records; give their prizes another vendor in Gift certificates.`,
        confirmLabel: "Remove vendor",
        destructive: true,
      }))
    )
      return;
    try {
      await remove({ data: { userId: v.user_id } });
      toast.success("Vendor removed");
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="mt-4 grid gap-4 text-left">
      <div className="rounded border border-border bg-card p-4">
        <h3 className="font-bold">Vendors</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Businesses that issue gift certificates. A vendor sees value requests (with a notification badge) on their account page, pays
          them in APE from the app, and enters winners' one-time codes when they redeem in person.
        </p>
        {data && !data.ready && <p className="mt-2 text-sm text-destructive">Vendors turn on after the database update (0019).</p>}
        {data?.ready && !data.rows.length && <p className="mt-3 text-sm text-muted-foreground">No vendors yet. Find a player below to promote.</p>}
        <ul className="mt-3 divide-y divide-border text-sm">
          {(data?.rows ?? []).map((v) => (
            <li key={v.user_id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="font-bold">{v.business_name}</p>
                <p className="break-all text-xs text-muted-foreground">
                  {v.username}
                  {v.location ? ` · ${v.location}` : ""} · wallet {short(v.wallet)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setForm({ userId: v.user_id, who: v.username, name: v.business_name, location: v.location ?? "", wallet: v.wallet ?? "" })}
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void demote(v)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded border border-border bg-card p-4">
        <h3 className="font-bold">Promote a player to vendor</h3>
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <Input className="h-10 w-64" placeholder="Search username, email or ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button size="sm" type="submit" variant="outline" disabled={isFetching || !query.trim()}>
            {isFetching ? "…" : "Search"}
          </Button>
        </form>
        {found && !found.rows.length && <p className="mt-2 text-sm text-muted-foreground">No players match.</p>}
        <ul className="mt-2 divide-y divide-border text-sm">
          {(found?.rows ?? []).slice(0, 20).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 break-all">
                <b>{a.displayName ?? "(no username)"}</b> <span className="text-xs text-muted-foreground">{a.email ?? a.id}</span>
              </span>
              {vendorIds.has(a.id) ? (
                <span className="text-xs text-muted-foreground">Already a vendor</span>
              ) : (
                <Button size="sm" onClick={() => setForm({ userId: a.id, who: a.displayName ?? a.email ?? "this player", name: "", location: "", wallet: "" })}>
                  Promote to vendor
                </Button>
              )}
            </li>
          ))}
        </ul>

        {form && (
          <div id="vendor-form" className="mt-4 grid gap-2 rounded border border-primary/60 p-3 sm:grid-cols-3">
            <p className="text-sm font-bold sm:col-span-3">{vendorIds.has(form.userId) ? "Edit vendor" : `New vendor: ${form.who}`}</p>
            <label className="text-xs text-muted-foreground">
              Business name
              <Input className="mt-1" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="text-xs text-muted-foreground">
              Location (shown to winners)
              <Input className="mt-1" value={form.location} maxLength={300} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </label>
            <label className="text-xs text-muted-foreground">
              Wallet (default issuer wallet)
              <Input className="mt-1 font-mono" placeholder="0x… (optional)" value={form.wallet} onChange={(e) => setForm({ ...form, wallet: e.target.value })} />
            </label>
            <div className="flex gap-2 sm:col-span-3">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : vendorIds.has(form.userId) ? "Save" : "Promote to vendor"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
