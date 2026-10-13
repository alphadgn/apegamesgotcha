// Admin → IRL claims → Shipping setup: where prizes ship from, the handling fee, and each IRL prize's box
// (weight and size), used for the live carrier prices winners pay. The ship-from address and fee are the super
// admin's; any admin can set prize boxes. See shipping.functions.ts.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { adminSetPrizeBox, adminSetShippingConfig, adminShippingSetup } from "@/lib/shipping.functions";
import { COUNTRIES } from "@/lib/countries";
import { useAuth } from "@/hooks/useAuth";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Box = { weight_oz: number; length_in: number; width_in: number; height_in: number };
const boxText = (b: Partial<Box>) => [b.weight_oz, b.length_in, b.width_in, b.height_in].map((v) => (v == null ? "" : String(v)));
function parseBox(t: string[]): Box | null {
  const n = t.map((x) => Number(x));
  if (n.some((x) => !Number.isFinite(x) || x <= 0)) return null;
  return { weight_oz: n[0]!, length_in: n[1]!, width_in: n[2]!, height_in: n[3]! };
}

export function ShippingSetup() {
  const fn = useServerFn(adminShippingSetup);
  const { data, refetch } = useQuery({ queryKey: ["admin-shipping"], queryFn: () => fn() });
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const problems = [
    !data.ready && "database update 0021",
    !data.shippoKey && "SHIPPO_API_KEY secret",
    data.fromMissing.length > 0 && `ship-from ${data.fromMissing.join(", ")}`,
    !data.treasury && "treasury wallet (Configuration → purchase)",
  ].filter(Boolean) as string[];
  return (
    <section className="rounded border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold">Shipping setup</h3>
          <p className="text-sm text-muted-foreground">
            Winners who choose shipping pay it: live carrier prices (Shippo) for their address, paid in APE to the treasury.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open setup"}
        </Button>
      </div>
      {problems.length ? (
        <p className="mt-2 rounded border border-destructive p-2 text-sm">
          Shipping prices are off until this is set: <b>{problems.join("; ")}</b>. Until then winners can only choose pick-up.
        </p>
      ) : (
        <p className="mt-2 text-sm text-primary">Shipping prices are on.</p>
      )}
      {open && (
        <div className="mt-4 space-y-6">
          <FromCard data={data} onSaved={() => void refetch()} />
          <BoxesCard data={data} onSaved={() => void refetch()} />
        </div>
      )}
    </section>
  );
}

type Setup = Awaited<ReturnType<typeof adminShippingSetup>>;

function FromCard({ data, onSaved }: { data: Setup; onSaved: () => void }) {
  const { isSuperAdmin } = useAuth();
  const save = useServerFn(adminSetShippingConfig);
  const empty = { name: "", company: "", street1: "", street2: "", city: "", state: "", zip: "", country: "US", phone: "", email: "" };
  const [f, setF] = useState(empty);
  const [fee, setFee] = useState("0");
  const [box, setBox] = useState(["16", "10", "8", "4"]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF({ ...empty, ...Object.fromEntries(Object.entries(data.config.from).map(([k, v]) => [k, String(v ?? "")])) });
    setFee(data.config.handling_usd);
    setBox(boxText(data.config.default_box));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.config]);
  const inp = (k: keyof typeof f, placeholder: string, cls = "") => (
    <Input className={cls} placeholder={placeholder} value={f[k]} disabled={!isSuperAdmin} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
  );
  const submit = async () => {
    const b = parseBox(box);
    if (!b) return void toast.error("Enter the default box weight (oz) and size (inches) as numbers.");
    if (
      !(await confirmAction({
        title: "Save the shipping settings?",
        description: `Prizes ship from ${f.city || "this address"}. Winners pay the carrier price${Number(fee) ? ` plus $${Number(fee).toFixed(2)} handling` : ""}.`,
        confirmLabel: "Save",
      }))
    )
      return;
    setBusy(true);
    try {
      await save({ data: { from: f, handling_usd: fee, default_box: b } });
      toast.success("Shipping settings saved");
      onSaved();
    } catch (e) {
      const m = (e as Error).message;
      toast.error(m.trim().startsWith("[") ? "Fill in name, street, city, ZIP, country, phone and email." : m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <h4 className="font-bold">Ship from</h4>
      <p className="text-xs text-muted-foreground">{isSuperAdmin ? "Carriers need a phone and email for the sender." : "Only the super admin can change these."}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {inp("name", "Sender name")}
        {inp("company", "Company (optional)")}
        {inp("street1", "Street address", "sm:col-span-2")}
        {inp("street2", "Suite (optional)", "sm:col-span-2")}
        {inp("city", "City")}
        {inp("state", "State (e.g. SC)")}
        {inp("zip", "ZIP")}
        <select
          aria-label="Country"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={f.country}
          disabled={!isSuperAdmin}
          onChange={(e) => setF({ ...f, country: e.target.value })}
        >
          {COUNTRIES.map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </select>
        {inp("phone", "Phone")}
        {inp("email", "Email")}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Packing & handling added to each rate ($)
          <Input className="mt-1" value={fee} disabled={!isSuperAdmin} onChange={(e) => setFee(e.target.value)} />
        </label>
        <div className="text-sm">
          Default box (prizes without their own)
          <BoxInputs value={box} onChange={setBox} disabled={!isSuperAdmin} />
        </div>
      </div>
      {isSuperAdmin && (
        <Button className="mt-3" size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save shipping settings"}
        </Button>
      )}
    </div>
  );
}

function BoxInputs({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const labels = ["Weight (oz)", "Length (in)", "Width (in)", "Height (in)"];
  return (
    <div className="mt-1 grid grid-cols-4 gap-1">
      {labels.map((l, i) => (
        <Input
          key={l}
          aria-label={l}
          placeholder={l}
          inputMode="decimal"
          value={value[i] ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(value.map((v, j) => (j === i ? e.target.value : v)))}
        />
      ))}
    </div>
  );
}

function BoxesCard({ data, onSaved }: { data: Setup; onSaved: () => void }) {
  const save = useServerFn(adminSetPrizeBox);
  const [edit, setEdit] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const submit = async (p: Setup["prizes"][number], useDefault: boolean) => {
    const b = useDefault ? null : parseBox(edit[p.id] ?? []);
    if (!useDefault && !b) return void toast.error("Enter weight (oz) and length, width, height (inches) as numbers.");
    if (
      !(await confirmAction({
        title: `Save the box for "${p.name}"?`,
        description: b ? `${b.weight_oz} oz, ${b.length_in} × ${b.width_in} × ${b.height_in} in. Shipping prices use this box.` : "This prize uses the default box.",
        confirmLabel: "Save",
      }))
    )
      return;
    setBusy(p.id);
    try {
      await save({ data: { prizeId: p.id, box: b } });
      toast.success("Box saved");
      setEdit(({ [p.id]: _, ...rest }) => rest);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const d = data.config.default_box;
  return (
    <div>
      <h4 className="font-bold">Box per IRL prize</h4>
      <p className="text-xs text-muted-foreground">
        Packed weight and box size. Without one, the default box is used ({d.weight_oz} oz, {d.length_in} × {d.width_in} × {d.height_in} in).
      </p>
      {!data.prizes.length && <p className="mt-2 text-sm text-muted-foreground">No IRL prizes yet.</p>}
      <ul className="mt-2 space-y-2">
        {data.prizes.map((p) => {
          const own = p.box.weight_oz != null;
          const editing = p.id in edit;
          return (
            <li key={p.id} className="rounded border border-border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1">
                  <b>{p.name}</b>
                  {!p.active && <span className="text-xs text-muted-foreground"> · inactive</span>}
                  <span className="block text-xs text-muted-foreground">
                    {own ? `${p.box.weight_oz} oz, ${p.box.length_in} × ${p.box.width_in} × ${p.box.height_in} in` : "Default box"}
                  </span>
                </p>
                {!editing && (
                  <Button size="sm" variant="outline" onClick={() => setEdit({ ...edit, [p.id]: boxText(own ? (p.box as Box) : d) })}>
                    Set box
                  </Button>
                )}
              </div>
              {editing && (
                <div className="mt-2">
                  <BoxInputs value={edit[p.id]!} onChange={(v) => setEdit({ ...edit, [p.id]: v })} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === p.id} onClick={() => void submit(p, false)}>
                      Save
                    </Button>
                    {own && (
                      <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void submit(p, true)}>
                        Use default box
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEdit(({ [p.id]: _, ...rest }) => rest)}>
                      Cancel
                    </Button>
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
