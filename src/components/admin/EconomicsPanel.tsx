import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminAdjustStock,
  adminEconomics,
  adminGrant,
  adminRecordFunding,
  adminSaveBudget,
  adminSaveOperatingCost,
  adminSavePrize,
  adminSetFulfillment,
} from "@/lib/economics.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, KV, QueryError, useAction } from "./common";

type Prize = {
  id?: string;
  name: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  weight: number;
  inventory: number | null;
  active: boolean;
  kind: "points_only" | "fulfillment_required";
  unit_cost_usd: string | null;
  cost_verified: boolean;
  stock_verified: boolean;
  economics_notes: string | null;
  onchain_index?: number | null;
};
type Status = {
  cost_estimate: {
    verified: boolean;
    unverified: string[];
    expected_cost_per_spin_usd: string | null;
    worst_case_cost_per_spin_usd: string | null;
    available_weight: string;
  };
  prize_issues: { prize: string; issue: string }[];
  liabilities: Record<string, string | number | null>;
  reserves: { prize_reserve_usd: string };
  sponsored_budgets: Record<
    string,
    {
      funded_usd: string;
      committed_usd: string;
      available_usd: string;
      low_water_usd: string;
      paused: boolean;
      pause_reason: string | null;
    }
  >;
  purchases_allowed: boolean;
  purchase_blockers: string[];
};

export function EconomicsPanel() {
  const load = useServerFn(adminEconomics);
  const savePrize = useServerFn(adminSavePrize);
  const stock = useServerFn(adminAdjustStock);
  const saveCost = useServerFn(adminSaveOperatingCost);
  const fund = useServerFn(adminRecordFunding);
  const budget = useServerFn(adminSaveBudget);
  const fulfil = useServerFn(adminSetFulfillment);
  const grant = useServerFn(adminGrant);
  const { data, error, refetch } = useQuery({ queryKey: ["admin-econ"], queryFn: () => load() });
  const { busy, run } = useAction();
  const [rows, setRows] = useState<Prize[]>([]);
  const [f, setF] = useState({ account: "prize_reserve", amount_usd: "", evidence: "" });
  const [g, setG] = useState({ email: "", spins: 1, points: "0", note: "" });
  useEffect(() => {
    if (data)
      setRows(
        (data.prizes as Prize[]).map((p) => ({
          ...p,
          unit_cost_usd: p.unit_cost_usd == null ? null : String(p.unit_cost_usd),
        })),
      );
  }, [data]);
  const st = data?.status as Status | undefined;
  const totalW = rows
    .filter((r) => r.active && (r.inventory == null || r.inventory > 0))
    .reduce((s, r) => s + r.weight, 0);
  const upd = (i: number, p: Partial<Prize>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const done = () => void refetch();

  return (
    <div className="mt-4 space-y-4">
      <QueryError error={error} />
      {st && (
        <Card title="Status">
          <KV
            k="Expected cost per spin"
            v={
              st.cost_estimate.expected_cost_per_spin_usd
                ? `$${st.cost_estimate.expected_cost_per_spin_usd}`
                : `unverified (${st.cost_estimate.unverified.join(", ")})`
            }
            warn={!st.cost_estimate.verified}
          />
          <KV
            k="Worst-case cost per spin"
            v={
              st.cost_estimate.worst_case_cost_per_spin_usd
                ? `$${st.cost_estimate.worst_case_cost_per_spin_usd}`
                : "unverified"
            }
            warn={!st.cost_estimate.verified}
          />
          <KV
            k="Remaining real prizes (worst case)"
            v={
              st.liabilities["remaining_real_prize_stock_usd"] != null
                ? `$${st.liabilities["remaining_real_prize_stock_usd"]}`
                : "unverified"
            }
          />
          <KV
            k="Pending fulfillment"
            v={`${st.liabilities["pending_fulfillment_count"]} · ${st.liabilities["pending_fulfillment_usd"] != null ? `$${st.liabilities["pending_fulfillment_usd"]}` : "unverified"}`}
          />
          <KV
            k="Unused credits"
            v={`${st.liabilities["unused_credits"]}${st.liabilities["unused_credits_worst_case_usd"] ? ` · worst case $${st.liabilities["unused_credits_worst_case_usd"]}` : ""}`}
          />
          <KV k="Prize reserve" v={`$${st.reserves.prize_reserve_usd}`} />
          <KV
            k="Purchases allowed"
            v={st.purchases_allowed ? "yes" : st.purchase_blockers.join(" · ")}
            warn={!st.purchases_allowed}
          />
          {st.prize_issues.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-destructive">
              {st.prize_issues.map((i) => (
                <li key={i.prize + i.issue}>
                  {i.prize}: {i.issue}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Prizes (classification, costs, odds)">
        <p className="mb-2 text-xs text-muted-foreground">
          Unlimited stock only for points-only prizes with a verified cost of 0. Real prizes need
          finite, verified stock (or reserved funding). Stock changes go through “Adjust stock”.
          Publish the pool on-chain afterwards.
        </p>
        <div className="overflow-x-auto">
          <div className="min-w-[980px]">
            <div className="grid grid-cols-[1.6fr_1fr_80px_70px_80px_1.3fr_90px_60px_60px_60px_140px] gap-2 font-mono text-[10px] uppercase text-muted-foreground">
              <span>Name</span>
              <span>Rarity</span>
              <span>Weight</span>
              <span>Odds</span>
              <span>Stock</span>
              <span>Kind</span>
              <span>Unit $</span>
              <span>Cost ✓</span>
              <span>Stock ✓</span>
              <span>Active</span>
              <span />
            </div>
            {rows.map((r, i) => (
              <div
                key={r.id ?? i}
                className="mt-2 grid grid-cols-[1.6fr_1fr_80px_70px_80px_1.3fr_90px_60px_60px_60px_140px] items-center gap-2"
              >
                <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
                <select
                  className="h-9 rounded border border-input bg-background px-1 text-xs"
                  value={r.rarity}
                  onChange={(e) => upd(i, { rarity: e.target.value as Prize["rarity"] })}
                >
                  {["common", "rare", "epic", "legendary"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <Input
                  type="number"
                  value={r.weight}
                  onChange={(e) => upd(i, { weight: +e.target.value })}
                />
                <span className="font-mono text-xs">
                  {totalW && r.active ? ((r.weight / totalW) * 100).toFixed(2) : "0"}%
                </span>
                <Input
                  placeholder="∞"
                  value={r.inventory ?? ""}
                  disabled={!!r.id && r.inventory != null}
                  onChange={(e) =>
                    upd(i, { inventory: e.target.value === "" ? null : +e.target.value })
                  }
                />
                <select
                  className="h-9 rounded border border-input bg-background px-1 text-xs"
                  value={r.kind}
                  onChange={(e) => upd(i, { kind: e.target.value as Prize["kind"] })}
                >
                  <option value="points_only">points only</option>
                  <option value="fulfillment_required">needs fulfillment</option>
                </select>
                <Input
                  placeholder="unverified"
                  value={r.unit_cost_usd ?? ""}
                  onChange={(e) =>
                    upd(i, { unit_cost_usd: e.target.value === "" ? null : e.target.value })
                  }
                />
                <input
                  type="checkbox"
                  checked={r.cost_verified}
                  onChange={(e) => upd(i, { cost_verified: e.target.checked })}
                />
                <input
                  type="checkbox"
                  checked={r.stock_verified}
                  onChange={(e) => upd(i, { stock_verified: e.target.checked })}
                />
                <input
                  type="checkbox"
                  checked={r.active}
                  onChange={(e) => upd(i, { active: e.target.checked })}
                />
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "prize",
                        async () => {
                          const { onchain_index: _o, ...rest } = r;
                          await savePrize({
                            data: { ...rest, economics_notes: rest.economics_notes ?? null },
                          });
                          done();
                        },
                        () => "Saved",
                      )
                    }
                  >
                    Save
                  </Button>
                  {r.id && r.inventory != null && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => {
                        const d = prompt("Stock change (+ restock / − write-off)");
                        const reason = d && prompt("Reason (audited)");
                        if (d && reason)
                          void run(
                            "stock",
                            () =>
                              stock({
                                data: { prizeId: r.id!, delta: parseInt(d, 10), reason },
                              }).then(done),
                            () => "Stock adjusted",
                          );
                      }}
                    >
                      Stock
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() =>
            setRows([
              ...rows,
              {
                name: "New prize",
                rarity: "common",
                weight: 1,
                inventory: 0,
                active: false,
                kind: "points_only",
                unit_cost_usd: null,
                cost_verified: false,
                stock_verified: false,
                economics_notes: null,
              },
            ])
          }
        >
          Add prize
        </Button>
      </Card>

      <Card title="Operating costs (per spin unless noted)">
        {(
          (data?.costs ?? []) as {
            key: string;
            amount_usd: string | null;
            verified: boolean;
            evidence: string | null;
          }[]
        ).map((c) => (
          <CostRow
            key={c.key}
            c={c}
            busy={!!busy}
            onSave={(v) =>
              run(
                "cost",
                () => saveCost({ data: v }).then(done),
                () => "Saved",
              )
            }
          />
        ))}
      </Card>

      <Card title="Funding (append-only)">
        <div className="grid gap-2 sm:grid-cols-[1fr_120px_2fr_auto]">
          <select
            className="h-9 rounded border border-input bg-background px-2 text-sm"
            value={f.account}
            onChange={(e) => setF({ ...f, account: e.target.value })}
          >
            {["prize_reserve", "sponsored_burn", "sponsored_grant", "sponsored_free_entry"].map(
              (a) => (
                <option key={a}>{a}</option>
              ),
            )}
          </select>
          <Input
            placeholder="USD (−: withdrawal)"
            value={f.amount_usd}
            onChange={(e) => setF({ ...f, amount_usd: e.target.value })}
          />
          <Input
            placeholder="evidence (receipt, tx, statement)"
            value={f.evidence}
            onChange={(e) => setF({ ...f, evidence: e.target.value })}
          />
          <Button
            size="sm"
            disabled={!!busy || !f.amount_usd || f.evidence.length < 3}
            onClick={() =>
              run(
                "fund",
                () =>
                  fund({
                    data: f as { account: "prize_reserve"; amount_usd: string; evidence: string },
                  }).then(() => {
                    setF({ ...f, amount_usd: "", evidence: "" });
                    done();
                  }),
                () => "Recorded",
              )
            }
          >
            Record
          </Button>
        </div>
        <div className="mt-3 space-y-1 font-mono text-xs">
          {(
            (data?.funding ?? []) as {
              id: number;
              account: string;
              amount_usd: string;
              evidence: string;
              created_at: string;
            }[]
          ).map((x) => (
            <div key={x.id}>
              {x.created_at.slice(0, 10)} · {x.account} · ${x.amount_usd} · {x.evidence}
            </div>
          ))}
        </div>
      </Card>

      {st && (
        <Card title="Sponsored spin budgets (burn / grant / free entry)">
          {Object.entries(st.sponsored_budgets).map(([src, b]) => (
            <div
              key={src}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm"
            >
              <span className="font-mono">
                {src}: funded ${b.funded_usd} · committed ${b.committed_usd} · available $
                {b.available_usd} {b.paused ? `· PAUSED (${b.pause_reason ?? ""})` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => {
                  const low =
                    prompt("Low-water mark in USD (grants pause below it)", b.low_water_usd) ??
                    b.low_water_usd;
                  void run(
                    "budget",
                    () =>
                      budget({
                        data: {
                          source: src as "burn",
                          paused: !b.paused,
                          low_water_usd: low,
                          reason: "Admin",
                        },
                      }).then(done),
                    () => (b.paused ? "Resumed" : "Paused"),
                  );
                }}
              >
                {b.paused ? "Resume" : "Pause"}
              </Button>
            </div>
          ))}
        </Card>
      )}

      <Card title="Sponsored grant">
        <p className="mb-2 text-xs text-muted-foreground">
          Spins come from the grant budget (worst-case cost reserved). Points need a season and a
          reason; both are audited.
        </p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input
            placeholder="player email"
            value={g.email}
            onChange={(e) => setG({ ...g, email: e.target.value })}
          />
          <Input
            type="number"
            placeholder="spins"
            value={g.spins}
            onChange={(e) => setG({ ...g, spins: +e.target.value })}
          />
          <Input
            placeholder="note (required)"
            className="sm:col-span-2"
            value={g.note}
            onChange={(e) => setG({ ...g, note: e.target.value })}
          />
        </div>
        <Button
          size="sm"
          className="mt-2"
          disabled={!!busy || g.note.length < 3}
          onClick={() =>
            run(
              "grant",
              () =>
                grant({ data: g }).then((r) => {
                  done();
                  return r;
                }),
              (r) => `Granted ${r.credits} spin(s)`,
            )
          }
        >
          Grant spins
        </Button>
      </Card>

      <Card title="Prize fulfillment">
        {(
          (data?.fulfillments ?? []) as {
            spin_id: string;
            status: string;
            unit_cost_usd: string | null;
            created_at: string;
            prize_id: string;
          }[]
        ).map((x) => (
          <div
            key={x.spin_id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 font-mono text-xs"
          >
            <span>
              {x.created_at.slice(0, 10)} · spin {x.spin_id.slice(0, 8)} ·{" "}
              {x.unit_cost_usd ? `$${x.unit_cost_usd}` : "cost unverified"}
            </span>
            <select
              className="h-7 rounded border border-input bg-background px-1"
              value={x.status}
              onChange={(e) =>
                void run(
                  "ful",
                  () =>
                    fulfil({
                      data: { spinId: x.spin_id, status: e.target.value as "pending", notes: null },
                    }).then(done),
                  () => "Updated",
                )
              }
            >
              {["pending", "shipped", "delivered", "cancelled"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        ))}
        {!data?.fulfillments?.length && (
          <p className="text-sm text-muted-foreground">Nothing owed yet.</p>
        )}
      </Card>
    </div>
  );
}

function CostRow({
  c,
  busy,
  onSave,
}: {
  c: { key: string; amount_usd: string | null; verified: boolean; evidence: string | null };
  busy: boolean;
  onSave: (v: {
    key: "vrf_per_spin";
    amount_usd: string | null;
    verified: boolean;
    evidence: string | null;
  }) => void;
}) {
  const [v, setV] = useState({
    amount: c.amount_usd == null ? "" : String(c.amount_usd),
    verified: c.verified,
    evidence: c.evidence ?? "",
  });
  return (
    <div className="grid items-center gap-2 border-b border-border py-2 sm:grid-cols-[160px_120px_70px_1fr_auto]">
      <span className="font-mono text-xs">{c.key}</span>
      <Input
        placeholder="unverified"
        value={v.amount}
        onChange={(e) => setV({ ...v, amount: e.target.value })}
      />
      <label className="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={v.verified}
          onChange={(e) => setV({ ...v, verified: e.target.checked })}
        />{" "}
        verified
      </label>
      <Input
        placeholder="evidence"
        value={v.evidence}
        onChange={(e) => setV({ ...v, evidence: e.target.value })}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          onSave({
            key: c.key as "vrf_per_spin",
            amount_usd: v.amount === "" ? null : v.amount,
            verified: v.verified,
            evidence: v.evidence || null,
          })
        }
      >
        Save
      </Button>
    </div>
  );
}
