// Admin → Grants & levels → Free-spin codes: make a code that gives spins for a time window (default 4 hours),
// each player once; see how many redeemed it; switch it off.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  adminCreateSpinCode,
  adminDisableSpinCode,
  adminListSpinCodes,
} from "@/lib/codes.functions";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function left(expires: string) {
  const ms = new Date(expires).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m left`;
}

export function SpinCodesCard() {
  const list = useServerFn(adminListSpinCodes);
  const create = useServerFn(adminCreateSpinCode);
  const disable = useServerFn(adminDisableSpinCode);
  const { data, refetch } = useQuery({
    queryKey: ["spin-codes"],
    queryFn: () => list(),
    refetchInterval: 60_000,
  });
  const [f, setF] = useState({
    spins: "1",
    kind: "real" as "real" | "demo",
    hours: "4",
    max: "",
    note: "",
  });
  const [busy, setBusy] = useState(false);

  const make = async () => {
    const spins = Number(f.spins),
      hours = Number(f.hours),
      max = f.max.trim() ? Number(f.max) : null;
    if (!Number.isInteger(spins) || spins < 1 || spins > 10)
      return void toast.error("Spins: 1 to 10");
    if (!(hours >= 0.25)) return void toast.error("Hours: at least 0.25");
    if (max != null && (!Number.isInteger(max) || max < 1))
      return void toast.error("Max players: a whole number, or leave empty");
    if (
      !(await confirmAction({
        title: `Make a code for ${spins} ${f.kind === "real" ? "real" : "demo"} spin${spins === 1 ? "" : "s"}?`,
        description: `Valid for ${hours} hour${hours === 1 ? "" : "s"} from now, once per player${max ? `, first ${max} players` : ""}.${f.kind === "real" ? " Real spins are on-chain draws that can win prizes." : ""}`,
        confirmLabel: "Make code",
      }))
    )
      return;
    setBusy(true);
    try {
      const r = await create({
        data: { spins, kind: f.kind, hours, maxRedemptions: max, note: f.note },
      });
      await navigator.clipboard?.writeText(r.code).catch(() => undefined);
      toast.success(`Code ${r.code} made (copied)`);
      setF({ ...f, note: "" });
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const off = async (id: string, code: string) => {
    if (
      !(await confirmAction({
        title: `Switch off code ${code}?`,
        description: "Nobody can redeem it after this. Spins already redeemed stay.",
        confirmLabel: "Switch off",
        destructive: true,
      }))
    )
      return;
    try {
      await disable({ data: { id } });
      toast.success("Code switched off");
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <section className="rounded border bg-card p-4 text-left text-sm">
      <h3 className="text-lg font-bold">Free-spin codes</h3>
      <p className="text-muted-foreground">
        Players redeem a code once each, from the Refill window or My Machine, while it's valid.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <label>
          Spins
          <Input
            className="mt-1"
            inputMode="numeric"
            value={f.spins}
            onChange={(e) => setF({ ...f, spins: e.target.value })}
          />
        </label>
        <label>
          Type
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2"
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as "real" | "demo" })}
          >
            <option value="real">Real (LIVE)</option>
            <option value="demo">Demo</option>
          </select>
        </label>
        <label>
          Valid for (hours)
          <Input
            className="mt-1"
            inputMode="decimal"
            value={f.hours}
            onChange={(e) => setF({ ...f, hours: e.target.value })}
          />
        </label>
        <label>
          Max players
          <Input
            className="mt-1"
            inputMode="numeric"
            placeholder="no limit"
            value={f.max}
            onChange={(e) => setF({ ...f, max: e.target.value })}
          />
        </label>
        <label>
          Note
          <Input
            className="mt-1"
            placeholder="optional"
            value={f.note}
            onChange={(e) => setF({ ...f, note: e.target.value })}
          />
        </label>
      </div>
      <Button className="mt-3" size="sm" disabled={busy} onClick={() => void make()}>
        {busy ? "Making…" : "Make code"}
      </Button>
      {data && !data.ready && (
        <p className="mt-2 text-destructive">Codes turn on after the database update (0024).</p>
      )}
      <ul className="mt-4 space-y-2">
        {(data?.rows ?? []).map((c) => {
          const live =
            !c.disabled &&
            new Date(c.expiresAt).getTime() > Date.now() &&
            new Date(c.startsAt).getTime() <= Date.now();
          return (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
            >
              <button
                type="button"
                className="font-mono text-base font-bold underline"
                title="Copy"
                onClick={() =>
                  void navigator.clipboard?.writeText(c.code).then(() => toast.success("Copied"))
                }
              >
                {c.code}
              </button>
              <span className="text-xs text-muted-foreground">
                {c.spins} {c.kind} spin{c.spins === 1 ? "" : "s"} · until{" "}
                {new Date(c.expiresAt).toLocaleString()} · {c.redeemed}
                {c.maxRedemptions ? `/${c.maxRedemptions}` : ""} redeemed
                {c.note ? ` · ${c.note}` : ""}
              </span>
              <span
                className={`ml-auto rounded px-2 py-0.5 text-xs font-bold ${live ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {c.disabled ? "off" : live ? left(c.expiresAt) : "expired"}
              </span>
              {live && (
                <Button size="sm" variant="ghost" onClick={() => void off(c.id, c.code)}>
                  Switch off
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
