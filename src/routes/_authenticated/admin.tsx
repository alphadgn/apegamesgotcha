import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { adminUpdateConfig, adminUpsertPrize, adminGrant, adminSetLevel, adminVrfStatus, adminPublishPool, adminSettleDraws } from "@/lib/app.functions";
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
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-4xl font-bold">Admin console</h1>
      <Tabs defaultValue="config" className="mt-6">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="prizes">Prizes & odds</TabsTrigger>
          <TabsTrigger value="vrf">Chainlink VRF</TabsTrigger>
          <TabsTrigger value="grants">Grants & levels</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="config"><ConfigPanel /></TabsContent>
        <TabsContent value="prizes"><PrizesPanel /></TabsContent>
        <TabsContent value="vrf"><VrfPanel /></TabsContent>
        <TabsContent value="grants"><GrantsPanel /></TabsContent>
        <TabsContent value="audit"><AuditPanel /></TabsContent>
      </Tabs>
    </main>
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

type Prize = { id?: string; name: string; rarity: "common" | "rare" | "epic" | "legendary"; weight: number; points: number; inventory: number | null; active: boolean };

function PrizesPanel() {
  const qc = useQueryClient();
  const save = useServerFn(adminUpsertPrize);
  const { data } = useQuery({ queryKey: ["prizes-admin"], queryFn: async () => (await supabase.from("prizes").select("*").order("created_at")).data ?? [] });
  const [rows, setRows] = useState<Prize[]>([]);
  useEffect(() => { if (data) setRows(data as Prize[]); }, [data]);
  const total = rows.filter((r) => r.active && (r.inventory == null || r.inventory > 0)).reduce((s, r) => s + r.weight, 0);
  const upd = (i: number, p: Partial<Prize>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="mt-4 rounded border border-border bg-card p-4">
      <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_60px_60px_80px] gap-2 font-mono text-xs uppercase text-muted-foreground">
        <span>Name</span><span>Rarity</span><span>Weight</span><span>Odds</span><span>Points</span><span>Stock</span><span>Active</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id ?? i} className="mt-2 grid grid-cols-[2fr_1fr_1fr_1fr_1fr_60px_60px_80px] items-center gap-2">
          <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
          <select className="h-9 rounded border border-input bg-background px-2 text-sm" value={r.rarity} onChange={(e) => upd(i, { rarity: e.target.value as Prize["rarity"] })}>
            {["common", "rare", "epic", "legendary"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <Input type="number" value={r.weight} onChange={(e) => upd(i, { weight: +e.target.value })} />
          <span className="font-mono text-sm">{total && r.active ? ((r.weight / total) * 100).toFixed(2) : "0"}%</span>
          <Input type="number" value={r.points} onChange={(e) => upd(i, { points: +e.target.value })} />
          <Input placeholder="∞" value={r.inventory ?? ""} onChange={(e) => upd(i, { inventory: e.target.value === "" ? null : +e.target.value })} />
          <input type="checkbox" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} />
          <Button size="sm" onClick={async () => {
            try { await save({ data: r }); toast.success("Saved"); qc.invalidateQueries({ queryKey: ["prizes-admin"] }); } catch (e) { toast.error((e as Error).message); }
          }}>Save</Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="mt-4" onClick={() => setRows([...rows, { name: "New prize", rarity: "common", weight: 1, points: 0, inventory: null, active: false }])}>Add prize</Button>
    </div>
  );
}

function VrfPanel() {
  const status = useServerFn(adminVrfStatus);
  const publish = useServerFn(adminPublishPool);
  const settle = useServerFn(adminSettleDraws);
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
            </>}
            <Row k="Spins pending in app" v={data.pendingDb} />
            {data.unpublished > 0 && <Row k="Prizes not yet on-chain" v={data.unpublished} warn />}
          </div>
        )}
        <Button variant="outline" size="sm" className="mt-3" disabled={isFetching} onClick={() => qc.invalidateQueries({ queryKey: ["vrf-status"] })}>Refresh</Button>
      </div>
      <div className="space-y-4 rounded border border-border bg-card p-4">
        <div>
          <h3 className="font-bold">Publish odds on-chain</h3>
          <p className="mt-1 text-sm text-muted-foreground">Sends the current prize weights and stock to the contract. Spins stay blocked while the app's odds differ from the contract's. The contract refuses changes while a draw is pending.</p>
          <Button className="mt-2" disabled={!!busy} onClick={() => act("publish", async () => { const r = await publish(); return `Published (${r.txHash.slice(0, 10)}…)`; })}>{busy === "publish" ? "Publishing…" : "Publish prize pool"}</Button>
        </div>
        <div>
          <h3 className="font-bold">Settle pending draws</h3>
          <p className="mt-1 text-sm text-muted-foreground">Records results Chainlink has delivered for players who left mid-draw, and returns credits for requests that never reached the chain.</p>
          <Button variant="secondary" className="mt-2" disabled={!!busy} onClick={() => act("settle", async () => { const r = await settle(); return `Settled ${r.before - r.after} of ${r.before}`; })}>{busy === "settle" ? "Settling…" : "Settle now"}</Button>
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
        <div key={a.id} className="grid grid-cols-[170px_160px_1fr] gap-3 border-b border-border px-4 py-2">
          <span className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
          <span className="text-primary">{a.action}</span>
          <span className="truncate">{JSON.stringify(a.details)}</span>
        </div>
      ))}
    </div>
  );
}
