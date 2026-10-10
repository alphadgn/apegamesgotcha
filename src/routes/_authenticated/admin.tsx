import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { adminUpdateConfig, adminUpsertPrize, adminRestockPrize, adminGrant, adminSetLevel, adminVrfStatus, adminPublishPool, adminReconcilePublication, adminSettleDraws, adminSetupStatus, adminRefreshEventInfo, adminEventInfoPages } from "@/lib/app.functions";
import { SeasonsPanel, SnapshotsPanel, SharesPanel, LedgerPanel, EconomicsPanel, OpsPanel } from "@/components/admin/SeasonAdmin";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin Console — ApeGames Gotcha" },
      { name: "description", content: "Manage configuration, prizes, grants and audit logs." },
      { property: "og:title", content: "Admin Console — ApeGames Gotcha" },
      { property: "og:description", content: "Manage configuration, prizes, grants and audit logs." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Admin,
});

function Admin() {
  const { isAdmin, loading } = useAuth();
  if (loading) return null;
  if (!isAdmin) return <main className="mx-auto max-w-3xl px-4 py-16 text-muted-foreground">Admins only.</main>;
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <h1 className="text-3xl font-bold sm:text-4xl">Admin console</h1>
      <Tabs defaultValue="setup" className="mt-6">
        <TabsList className="h-auto flex-wrap justify-center gap-1">
          <TabsTrigger value="setup">Setup checklist</TabsTrigger>
          <TabsTrigger value="seasons">Seasons</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
          <TabsTrigger value="shares">Shares</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="economics">Economics</TabsTrigger>
          <TabsTrigger value="ops">Operations</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="prizes">Prizes & odds</TabsTrigger>
          <TabsTrigger value="vrf">Chainlink VRF</TabsTrigger>
          <TabsTrigger value="grants">Grants & levels</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="setup"><SetupPanel /></TabsContent>
        <TabsContent value="seasons"><SeasonsPanel /></TabsContent>
        <TabsContent value="snapshots"><SnapshotsPanel /></TabsContent>
        <TabsContent value="shares"><SharesPanel /></TabsContent>
        <TabsContent value="ledger"><LedgerPanel /></TabsContent>
        <TabsContent value="economics"><EconomicsPanel /></TabsContent>
        <TabsContent value="ops"><OpsPanel /></TabsContent>
        <TabsContent value="config"><ConfigPanel /></TabsContent>
        <TabsContent value="prizes"><PrizesPanel /></TabsContent>
        <TabsContent value="vrf"><VrfPanel /></TabsContent>
        <TabsContent value="grants"><GrantsPanel /></TabsContent>
        <TabsContent value="audit"><AuditPanel /></TabsContent>
      </Tabs>
    </main>
  );
}

function SetupPanel() {
  const status = useServerFn(adminSetupStatus);
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["setup-status"], queryFn: () => status() });
  const groups = [...new Set((data ?? []).map((i) => i.group))];
  const missing = (data ?? []).filter((i) => !i.ok && !i.optional).length;
  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {data ? (missing ? `${missing} required item${missing === 1 ? "" : "s"} left before real spins and purchases work.` : "Everything required is in place.") : "Checking…"}
        </p>
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Checking…" : "Re-check"}</Button>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {groups.map((g) => (
        <div key={g} className="rounded border border-border bg-card p-4">
          <h3 className="font-bold">{g}</h3>
          <ul className="mt-2 divide-y divide-border">
            {data!.filter((i) => i.group === g).map((i) => (
              <li key={i.label} className="grid gap-1 py-3 sm:grid-cols-[28px_1fr]">
                <span aria-hidden className={i.ok ? "text-primary" : i.optional ? "text-muted-foreground" : "text-destructive"}>{i.ok ? "✓" : i.optional ? "○" : "✗"}</span>
                <div>
                  <p className="font-medium">{i.label}{i.optional ? <span className="text-muted-foreground"> (optional)</span> : null}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{i.detail}</p>
                  {!i.ok && <p className="mt-1 text-sm">Where: {i.where}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <EventInfoCard onRefreshed={() => void refetch()} />
    </div>
  );
}

/** Pages the guide reads about ApeFest 2026, fetched from the BAYC site with Firecrawl. */
function EventInfoCard({ onRefreshed }: { onRefreshed: () => void }) {
  const list = useServerFn(adminEventInfoPages);
  const refresh = useServerFn(adminRefreshEventInfo);
  const { data, refetch } = useQuery({ queryKey: ["event-info-pages"], queryFn: () => list() });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await refresh();
      toast.success(`Fetched ${r.saved} BAYC page${r.saved === 1 ? "" : "s"}${r.errors.length ? ` · ${r.errors.length} problem(s)` : ""}`);
      if (r.errors.length) console.warn("[event info]", r.errors);
      void refetch();
      onRefreshed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-bold">ApeFest 2026 pages the guide reads</h3>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>{busy ? "Fetching…" : "Refresh ApeFest info"}</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Fetched from boredapeyachtclub.com with Firecrawl, refreshed automatically every few hours. Sources and search terms: Configuration → event_info.</p>
      {data?.length ? (
        <ul className="mt-3 space-y-1 text-left text-xs">
          {data.map((p) => (
            <li key={p.url} className="break-all font-mono"><a className="text-primary hover:underline" href={p.url} target="_blank" rel="noreferrer">{p.title || p.url}</a> <span className="text-muted-foreground">· {p.source} · {new Date(p.fetched_at).toLocaleString()}</span></li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-muted-foreground">Nothing fetched yet.</p>}
    </div>
  );
}

function ConfigPanel() {
  const { data } = useQuery({ queryKey: ["config"], queryFn: async () => (await supabase.from("app_config").select("*").order("key")).data ?? [] });
  return <div className="mt-4 grid gap-4 md:grid-cols-2">{data?.map((c) => <ConfigEditor key={c.key} row={c} />)}</div>;
}

function ConfigEditor({ row }: { row: { key: string; value: unknown; version: number; updated_at: string } }) {
  const [text, setText] = useState(JSON.stringify(row.value, null, 2));
  useEffect(() => setText(JSON.stringify(row.value, null, 2)), [row.value]);
  const save = useServerFn(adminUpdateConfig);
  const qc = useQueryClient();
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="flex justify-between"><h3 className="font-bold">{row.key}</h3><span className="font-mono text-xs text-muted-foreground">v{row.version}</span></div>
      <Textarea className="mt-2 h-48 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="sm" className="mt-2" onClick={async () => {
        try { await save({ data: { key: row.key, value: JSON.parse(text) } }); toast.success(`Saved ${row.key}`); qc.invalidateQueries({ queryKey: ["config"] }); }
        catch (e) { toast.error((e as Error).message); }
      }}>Save new version</Button>
    </div>
  );
}

type Prize = { id?: string; name: string; rarity: "common" | "rare" | "epic" | "legendary"; weight: number; inventory: number | null; active: boolean; fulfillment_type: "unclassified" | "points_only" | "digital_free" | "fulfillment_required"; onchain_index?: number | null };

function PrizesPanel() {
  const qc = useQueryClient();
  const save = useServerFn(adminUpsertPrize);
  const restock = useServerFn(adminRestockPrize);
  const { data } = useQuery({ queryKey: ["prizes-admin"], queryFn: async () => (await supabase.from("prizes").select("*").order("created_at")).data ?? [] });
  const [rows, setRows] = useState<Prize[]>([]);
  useEffect(() => { if (data) setRows(data as unknown as Prize[]); }, [data]);
  const total = rows.filter((r) => r.active && (r.inventory == null || r.inventory > 0)).reduce((s, r) => s + r.weight, 0);
  const upd = (i: number, p: Partial<Prize>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="mt-4 overflow-x-auto rounded border border-border bg-card p-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Season points for prizes come from the season rules (rarity bonus or per-prize override), not from this table. Unlimited stock is only allowed for
        points-only or cost-free digital prizes. Stock of a published prize only goes up through an audited restock. Publish on-chain after changes.
      </p>
      <div className="grid min-w-[760px] grid-cols-[2fr_1fr_1fr_1fr_1.4fr_70px_50px_150px] gap-2 font-mono text-xs uppercase text-muted-foreground">
        <span>Name</span><span>Rarity</span><span>Weight</span><span>Odds</span><span>Type</span><span>Stock</span><span>On</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id ?? i} className="mt-2 grid min-w-[760px] grid-cols-[2fr_1fr_1fr_1fr_1.4fr_70px_50px_150px] items-center gap-2">
          <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
          <select className="h-9 rounded border border-input bg-background px-2 text-sm" value={r.rarity} onChange={(e) => upd(i, { rarity: e.target.value as Prize["rarity"] })}>
            {["common", "rare", "epic", "legendary"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <Input type="number" value={r.weight} onChange={(e) => upd(i, { weight: +e.target.value })} />
          <span className="font-mono text-sm">{total && r.active ? ((r.weight / total) * 100).toFixed(2) : "0"}%</span>
          <select className="h-9 rounded border border-input bg-background px-2 text-sm" value={r.fulfillment_type} onChange={(e) => upd(i, { fulfillment_type: e.target.value as Prize["fulfillment_type"] })}>
            <option value="unclassified">unclassified</option>
            <option value="points_only">points only</option>
            <option value="digital_free">cost-free digital</option>
            <option value="fulfillment_required">needs fulfilment</option>
          </select>
          <Input placeholder="∞" value={r.inventory ?? ""} onChange={(e) => upd(i, { inventory: e.target.value === "" ? null : +e.target.value })} />
          <input type="checkbox" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} />
          <span className="flex gap-1">
            <Button size="sm" onClick={async () => {
              try {
                await save({ data: { ...(r.id ? { id: r.id } : {}), name: r.name, rarity: r.rarity, weight: r.weight, inventory: r.inventory, active: r.active, fulfillment_type: r.fulfillment_type } });
                toast.success("Saved");
                void qc.invalidateQueries({ queryKey: ["prizes-admin"] });
              } catch (e) { toast.error((e as Error).message); }
            }}>Save</Button>
            {r.id && r.inventory != null && (
              <Button size="sm" variant="outline" onClick={async () => {
                const qty = Number(window.prompt("Units to add (audited restock):") ?? "0");
                const evidence = qty > 0 ? window.prompt("Evidence (delivery note, invoice…):") : null;
                if (!qty || !evidence) return;
                try { await restock({ data: { prizeId: r.id!, quantity: qty, evidence } }); toast.success("Restocked"); void qc.invalidateQueries({ queryKey: ["prizes-admin"] }); } catch (e) { toast.error((e as Error).message); }
              }}>+Stock</Button>
            )}
          </span>
        </div>
      ))}
      <Button variant="outline" size="sm" className="mt-4" onClick={() => setRows([...rows, { name: "New prize", rarity: "common", weight: 1, inventory: null, active: false, fulfillment_type: "unclassified" }])}>Add prize</Button>
    </div>
  );
}

function VrfPanel() {
  const status = useServerFn(adminVrfStatus);
  const publish = useServerFn(adminPublishPool);
  const settle = useServerFn(adminSettleDraws);
  const reconcile = useServerFn(adminReconcilePublication);
  const qc = useQueryClient();
  const { data, error, isFetching } = useQuery({ queryKey: ["vrf-status"], queryFn: () => status() });
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (k: string, fn: () => Promise<string>) => {
    setBusy(k);
    try { toast.success(await fn()); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); qc.invalidateQueries({ queryKey: ["vrf-status"] }); }
  };
  const Row = ({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) => (
    <div className="flex justify-between border-b border-border py-2 text-sm"><span className="text-muted-foreground">{k}</span><span className={warn ? "text-destructive" : ""}>{v}</span></div>
  );
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div className="rounded border border-border bg-card p-4">
        <h3 className="font-bold">Draw contract</h3>
        <p className="mt-1 text-sm text-muted-foreground">Every capsule is drawn by the GotchaVRF contract using Chainlink VRF. Edit the <span className="font-mono">vrf</span> config to point at your deployment.</p>
        {error && <p className="mt-3 text-sm text-destructive">{(error as Error).message}</p>}
        {data && (
          <div className="mt-3 font-mono">
            <Row k="Spins enabled" v={data.enabled ? "yes" : "no"} warn={!data.enabled} />
            <Row k="Contract" v={data.configured ? (data.contractUrl ? <a className="underline" href={data.contractUrl} target="_blank" rel="noreferrer">{data.contract.slice(0, 10)}…</a> : data.contract) : "not set"} warn={!data.configured} />
            {data.configured && <>
              <Row k="Odds in sync with contract" v={data.oddsInSync ? "yes" : "no — publish"} warn={!data.oddsInSync} />
              <Row k="Pool version" v={data.poolVersion} />
              <Row k="Draws pending on-chain" v={data.pendingOnChain} />
              <Row k="New requests paused on-chain" v={data.requestsPaused ? "yes" : "no"} warn={data.requestsPaused} />
              <Row k="VRF subscription" v={"error" in data.subscription ? data.subscription.error : `${data.subscription.balance} wei${data.subscription.isConsumer ? "" : " · NOT a consumer"}`} warn={"error" in data.subscription || !data.subscription.isConsumer || data.subscription.balance === "0"} />
            </>}
            {data.lastPublication && <Row k="Last publication" v={`${data.lastPublication.status}${data.lastPublication.pool_version ? ` v${data.lastPublication.pool_version}` : ""}`} warn={data.lastPublication.status !== "confirmed"} />}
            <Row k="Spins pending in app" v={data.pendingDb} />
            {data.unpublished > 0 && <Row k="Prizes not yet on-chain" v={data.unpublished} warn />}
          </div>
        )}
        <Button variant="outline" size="sm" className="mt-3" disabled={isFetching} onClick={() => qc.invalidateQueries({ queryKey: ["vrf-status"] })}>Refresh</Button>
      </div>
      <div className="space-y-4 rounded border border-border bg-card p-4">
        <div>
          <h3 className="font-bold">Publish odds on-chain</h3>
          <p className="mt-1 text-sm text-muted-foreground">Reconciles stock with the contract, sends the weights and stock, then confirms by reading the contract back. Needs every draw settled; new draws wait while it runs.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={!!busy} onClick={() => act("publish", async () => { const r = await publish(); return `Publication ${r.status} (${r.txHash.slice(0, 10)}…)`; })}>{busy === "publish" ? "Publishing…" : "Publish prize pool"}</Button>
            <Button variant="outline" disabled={!!busy} onClick={() => act("reconcile", async () => `Publication: ${(await reconcile()).status}`)}>Reconcile open publication</Button>
          </div>
        </div>
        <div>
          <h3 className="font-bold">Settle pending draws</h3>
          <p className="mt-1 text-sm text-muted-foreground">Runs one pass of the settlement worker now (it also runs on its schedule): confirms requests, resends stored transactions and records Chainlink results. It never refunds on a timeout.</p>
          <Button variant="secondary" className="mt-2" disabled={!!busy} onClick={() => act("settle", async () => { const r = await settle(); return `Worker pass: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing to do"}`; })}>{busy === "settle" ? "Settling…" : "Run settlement pass"}</Button>
        </div>
      </div>
    </div>
  );
}

function GrantsPanel() {
  const grant = useServerFn(adminGrant);
  const setLevel = useServerFn(adminSetLevel);
  const [g, setG] = useState({ email: "", spins: 1, points: 0, note: "" });
  const [lv, setLv] = useState({ tokenId: "", level: "" });
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div className="space-y-2 rounded border border-border bg-card p-4">
        <h3 className="font-bold">Grant spins / adjust points</h3>
        <p className="text-sm text-muted-foreground">Granted spins draw from a funded “grant” budget (Economics). Point adjustments apply to the active season and are audited. A reason is required.</p>
        <Input placeholder="user email" value={g.email} onChange={(e) => setG({ ...g, email: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <Input type="number" placeholder="spins" value={g.spins} onChange={(e) => setG({ ...g, spins: +e.target.value })} />
          <Input type="number" placeholder="points (+/-)" value={g.points} onChange={(e) => setG({ ...g, points: +e.target.value })} />
        </div>
        <Input placeholder="reason / note" value={g.note} onChange={(e) => setG({ ...g, note: e.target.value })} />
        <Button onClick={async () => { try { await grant({ data: g }); toast.success("Granted"); } catch (e) { toast.error((e as Error).message); } }}>Apply</Button>
      </div>
      <div className="space-y-2 rounded border border-border bg-card p-4">
        <h3 className="font-bold">Override NFT level</h3>
        <p className="text-sm text-muted-foreground">Use when on-chain traits can't be read. Leave level empty to clear.</p>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="token ID" value={lv.tokenId} onChange={(e) => setLv({ ...lv, tokenId: e.target.value })} />
          <Input placeholder="level" value={lv.level} onChange={(e) => setLv({ ...lv, level: e.target.value })} />
        </div>
        <Button onClick={async () => { try { await setLevel({ data: { tokenId: lv.tokenId, level: lv.level === "" ? null : +lv.level } }); toast.success("Updated"); } catch (e) { toast.error((e as Error).message); } }}>Save</Button>
      </div>
    </div>
  );
}

function AuditPanel() {
  const { data } = useQuery({ queryKey: ["audit"], queryFn: async () => (await supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(200)).data ?? [] });
  return (
    <div className="mt-4 rounded border border-border bg-card font-mono text-xs">
      {data?.map((a) => (
        <div key={a.id} className="grid gap-1 sm:grid-cols-[170px_160px_1fr] sm:gap-3 border-b border-border px-4 py-2">
          <span className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
          <span className="text-primary">{a.action}</span>
          <span className="break-all sm:truncate">{JSON.stringify(a.details)}</span>
        </div>
      ))}
    </div>
  );
}
