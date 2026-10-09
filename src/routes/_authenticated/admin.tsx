import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { adminUpdateConfig, adminSetLevel, adminSetupStatus, adminRefreshEventInfo, adminEventInfoPages } from "@/lib/app.functions";
import { SeasonsPanel } from "@/components/admin/SeasonsPanel";
import { SnapshotPanel } from "@/components/admin/SnapshotPanel";
import { SharesPanel } from "@/components/admin/SharesPanel";
import { LedgerPanel } from "@/components/admin/LedgerPanel";
import { EconomicsPanel } from "@/components/admin/EconomicsPanel";
import { SettlementPanel } from "@/components/admin/SettlementPanel";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin Console — ApeGames Gotcha" },
      { name: "description", content: "Manage seasons, draws, economics, verification queues and audit logs." },
      { property: "og:title", content: "Admin Console — ApeGames Gotcha" },
      { property: "og:description", content: "Manage seasons, draws, economics, verification queues and audit logs." },
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
      <Tabs defaultValue="setup" className="mt-6">
        <TabsList className="flex h-auto flex-wrap justify-center">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="seasons">Seasons</TabsTrigger>
          <TabsTrigger value="snapshot">2025 snapshot</TabsTrigger>
          <TabsTrigger value="shares">X shares</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="economics">Economics</TabsTrigger>
          <TabsTrigger value="settlement">Draws & alerts</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="levels">NFT levels</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="setup"><SetupPanel /></TabsContent>
        <TabsContent value="seasons"><SeasonsPanel /></TabsContent>
        <TabsContent value="snapshot"><SnapshotPanel /></TabsContent>
        <TabsContent value="shares"><SharesPanel /></TabsContent>
        <TabsContent value="ledger"><LedgerPanel /></TabsContent>
        <TabsContent value="economics"><EconomicsPanel /></TabsContent>
        <TabsContent value="settlement"><SettlementPanel /></TabsContent>
        <TabsContent value="config"><ConfigPanel /></TabsContent>
        <TabsContent value="levels"><LevelsPanel /></TabsContent>
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

function LevelsPanel() {
  const setLevel = useServerFn(adminSetLevel);
  const [lv, setLv] = useState({ tokenId: "", level: "" });
  return (
    <div className="mx-auto mt-4 max-w-md space-y-2 rounded border border-border bg-card p-4">
      <h3 className="font-bold">Override NFT level</h3>
      <p className="text-sm text-muted-foreground">Display only — use when on-chain traits can't be read. Leave level empty to clear. Spin grants and points live under Economics and Ledger.</p>
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="token ID" value={lv.tokenId} onChange={(e) => setLv({ ...lv, tokenId: e.target.value })} />
        <Input placeholder="level" value={lv.level} onChange={(e) => setLv({ ...lv, level: e.target.value })} />
      </div>
      <Button onClick={async () => { try { await setLevel({ data: { tokenId: lv.tokenId, level: lv.level === "" ? null : +lv.level } }); toast.success("Updated"); } catch (e) { toast.error((e as Error).message); } }}>Save</Button>
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
