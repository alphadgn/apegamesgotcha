import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { adminUpdateConfig, adminUpsertPrize, adminGrant, adminListGrants, adminDeleteGrant, adminSetLeaderboardMode, adminListWinners, adminMarkDelivered, adminSetLevel, adminVrfStatus, adminVrfSetup, adminVrfTopUp, adminVrfSwitch, adminVrfSubscription, adminPurchaseSwitch, adminListPurchases, adminPublishPool, adminSettleDraws, adminSetupStatus, adminRefreshEventInfo, adminEventInfoPages } from "@/lib/app.functions";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Leaderboard, useLeaderboardMode } from "@/components/Leaderboard";

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
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="prizes">Prizes & odds</TabsTrigger>
          <TabsTrigger value="vrf">Chainlink VRF</TabsTrigger>
          <TabsTrigger value="grants">Grants & levels</TabsTrigger>
          <TabsTrigger value="board">Leaderboard & prizes</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="setup"><SetupPanel /></TabsContent>
        <TabsContent value="config"><ConfigPanel /></TabsContent>
        <TabsContent value="prizes"><PrizesPanel /></TabsContent>
        <TabsContent value="vrf"><VrfPanel /></TabsContent>
        <TabsContent value="grants"><GrantsPanel /></TabsContent>
        <TabsContent value="board"><BoardPanel /></TabsContent>
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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
    <div className="mt-4 overflow-x-auto rounded border border-border bg-card p-4">
      <p className="mb-2 text-xs text-muted-foreground sm:hidden">Swipe sideways to see every column.</p>
      <div className="grid min-w-[720px] grid-cols-[2fr_1fr_1fr_1fr_1fr_60px_60px_80px] gap-2 font-mono text-xs uppercase text-muted-foreground">
        <span>Name</span><span>Rarity</span><span>Weight</span><span>Odds</span><span>Points</span><span>Stock</span><span>Active</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id ?? i} className="mt-2 grid min-w-[720px] grid-cols-[2fr_1fr_1fr_1fr_1fr_60px_60px_80px] items-center gap-2">
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
    <div className="flex justify-between gap-3 border-b border-border py-2 text-left text-sm"><span className="text-muted-foreground">{k}</span><span className={`break-all text-right ${warn ? "text-destructive" : ""}`}>{v}</span></div>
  );
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <DrawSetupCard enabled={!!data?.enabled} oddsInSync={!!(data && data.configured && data.oddsInSync)} />
      <PurchasesCard drawOn={!!data?.enabled} />
      <div className="rounded border border-border bg-card p-4">
        <h3 className="font-bold">Draw contract</h3>
        <p className="mt-1 text-sm text-muted-foreground">Every capsule is drawn by the GotchaVRF contract using Chainlink VRF. Set it up with the button above.</p>
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

/** One-click on-chain draw: set up (subscription + contract), fund, and switch real spins on/off. */
function DrawSetupCard({ enabled, oddsInSync }: { enabled: boolean; oddsInSync: boolean }) {
  const qc = useQueryClient();
  const setup = useServerFn(adminVrfSetup);
  const topUp = useServerFn(adminVrfTopUp);
  const toggle = useServerFn(adminVrfSwitch);
  const subFn = useServerFn(adminVrfSubscription);
  const { data: sub, refetch } = useQuery({ queryKey: ["vrf-sub"], queryFn: () => subFn() });
  const [network, setNetwork] = useState<"base" | "base-sepolia" | "custom">("base");
  const [fundEth, setFundEth] = useState("0.01");
  const [topEth, setTopEth] = useState("0.01");
  const [custom, setCustom] = useState({ chain: "", chain_id: "", rpc_url: "", explorer_url: "", coordinator: "", key_hash: "" });
  const [steps, setSteps] = useState<{ step: string; detail: string; url?: string | undefined }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const done = () => {
    setBusy(null);
    void refetch();
    void qc.invalidateQueries({ queryKey: ["vrf-status"] });
    void qc.invalidateQueries({ queryKey: ["vrf-open"] });
  };
  const s = sub?.sub && !("error" in sub.sub) ? sub.sub : null;
  const subError = sub?.sub && "error" in sub.sub ? sub.sub.error : null;
  return (
    <div className="space-y-3 rounded border border-primary/60 bg-card p-4 text-left md:col-span-2">
      <h3 className="font-bold">Set up the on-chain draw</h3>
      <p className="text-sm text-muted-foreground">
        One button does the Chainlink side: it creates a VRF subscription paid in ETH, funds it, deploys the draw contract and connects the two,
        using the operator wallet (server secret <span className="font-mono">VRF_OPERATOR_PRIVATE_KEY</span>). That wallet needs a little ETH on the
        network you pick. If a step fails, press it again: finished steps are kept.
      </p>
      <p className="text-sm">
        Operator wallet: <span className="break-all font-mono">{sub?.operator ?? "not set — add the secret first"}</span>
        {s?.operator && <> · {Number(s.operator.eth).toFixed(5)} ETH</>}
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <label className="text-xs text-muted-foreground">
          Network
          <select className="mt-1 h-10 w-full rounded border border-border bg-background px-2 text-sm text-foreground" value={network} onChange={(e) => setNetwork(e.target.value as typeof network)}>
            <option value="base">Base (real)</option>
            <option value="base-sepolia">Base Sepolia (test, free ETH from a faucet)</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Fund with (ETH)
          <Input value={fundEth} inputMode="decimal" onChange={(e) => setFundEth(e.target.value)} />
        </label>
        <Button
          disabled={!!busy || enabled || !sub?.operator}
          onClick={async () => {
            setBusy("setup");
            setSteps([]);
            try {
              const r = await setup({
                data: {
                  network,
                  fundEth,
                  ...(network === "custom" ? { custom: { ...custom, chain_id: Number(custom.chain_id) } } : {}),
                },
              });
              setSteps(r.steps);
              toast.success("On-chain draw is set up. Publish the prize pool, then switch real spins on.");
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              done();
            }
          }}
        >
          {busy === "setup" ? "Setting up… (about a minute)" : "Set up"}
        </Button>
      </div>
      {enabled && <p className="text-xs text-muted-foreground">Switch real spins off to change the network or redeploy.</p>}
      {network === "custom" && (
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(custom) as (keyof typeof custom)[]).map((k) => (
            <Input key={k} placeholder={k} value={custom[k]} onChange={(e) => setCustom({ ...custom, [k]: e.target.value })} />
          ))}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {steps.map((x, i) => (
            <li key={i}>
              <b>{x.step}</b> — <span className="break-all">{x.detail}</span>{" "}
              {x.url && <a className="underline" href={x.url} target="_blank" rel="noreferrer">tx ↗</a>}
            </li>
          ))}
        </ol>
      )}
      {subError && <p className="text-sm text-destructive">{subError}</p>}
      {s && (
        <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
          <p className="text-sm">
            Subscription on {sub?.network}: <b>{Number(s.nativeBalanceEth).toFixed(5)} ETH</b> left · {s.consumers.length} contract
            {s.consumers.length === 1 ? "" : "s"} connected. Each draw is paid from this balance; keep it topped up.
          </p>
          <label className="text-xs text-muted-foreground">
            Add (ETH)
            <Input value={topEth} inputMode="decimal" onChange={(e) => setTopEth(e.target.value)} />
          </label>
          <Button
            variant="outline"
            disabled={!!busy}
            onClick={async () => {
              setBusy("top");
              try {
                await topUp({ data: { eth: topEth } });
                toast.success(`Added ${topEth} ETH`);
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                done();
              }
            }}
          >
            {busy === "top" ? "Sending…" : "Top up"}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-sm">
          Real spins are <b className={enabled ? "text-primary" : "text-destructive"}>{enabled ? "ON" : "OFF"}</b>
          {!enabled && !oddsInSync ? " · publish the prize pool before switching on" : ""}
        </p>
        <Button
          variant={enabled ? "outline" : "default"}
          disabled={!!busy}
          onClick={async () => {
            setBusy("switch");
            try {
              const r = await toggle({ data: { enabled: !enabled } });
              toast.success(r.enabled ? "Real spins are on — every spin is drawn by Chainlink VRF" : "Real spins are off");
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              done();
            }
          }}
        >
          {busy === "switch" ? "Saving…" : enabled ? "Switch real spins off" : "Switch real spins on"}
        </Button>
      </div>
    </div>
  );
}

/** $APE spin purchases: on/off (only once the draw is on) and the latest purchases. */
function PurchasesCard({ drawOn }: { drawOn: boolean }) {
  const qc = useQueryClient();
  const toggle = useServerFn(adminPurchaseSwitch);
  const list = useServerFn(adminListPurchases);
  const { data: cfg } = useQuery({
    queryKey: ["purchase-config"],
    queryFn: async () => ((await supabase.from("app_config").select("value").eq("key", "purchase").maybeSingle()).data?.value ?? {}) as { enabled?: boolean; treasury?: string; price_usd_per_spin?: string; price_ape_per_spin?: string },
  });
  const { data: rows, refetch } = useQuery({ queryKey: ["purchases"], queryFn: () => list() });
  const [busy, setBusy] = useState(false);
  const on = !!cfg?.enabled;
  return (
    <div className="space-y-3 rounded border border-border bg-card p-4 text-left md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">Spin purchases ($APE on ApeChain)</h3>
        <Button
          variant={on ? "outline" : "default"}
          disabled={busy || (!on && !drawOn)}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await toggle({ data: { enabled: !on } });
              toast.success(r.enabled ? "Refill now charges APE and adds spins" : "Purchases are off");
              await qc.invalidateQueries({ queryKey: ["purchase-config"] });
              await qc.invalidateQueries({ queryKey: ["purchase-settings"] });
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : on ? "Switch purchases off" : "Switch purchases on"}
        </Button>
      </div>
      <p className="text-sm">
        Purchases are <b className={on ? "text-primary" : "text-destructive"}>{on ? "ON" : "OFF"}</b> · price{" "}
        {cfg?.price_usd_per_spin ? `$${cfg.price_usd_per_spin} per spin (paid in APE at the live rate)` : `${cfg?.price_ape_per_spin ?? "?"} APE per spin`} · treasury{" "}
        <span className="break-all font-mono">{cfg?.treasury || "not set"}</span>
        {!drawOn && !on ? " · switch real spins on first" : ""}
      </p>
      {!!rows?.length && (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span className="min-w-0 break-all">
                {r.player} · {r.quantity} spins · {Number(r.ape).toFixed(4)} APE
              </span>
              <span className="text-xs text-muted-foreground">
                {r.status} · {new Date(r.at).toLocaleString()} {r.tx && <a className="underline" href={r.tx} target="_blank" rel="noreferrer">tx ↗</a>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="outline" onClick={() => void refetch()}>Refresh purchases</Button>
    </div>
  );
}

const GRANT_KINDS = {
  real: {
    label: "Paid-equivalent",
    short: "Paid-equiv.",
    help: "Same as a purchased spin: a real on-chain Chainlink draw that wins prizes and points. Needs the on-chain draw switched on (Chainlink VRF tab).",
    badge: "border-primary/60 bg-primary/15 text-primary",
  },
  demo: {
    label: "Demo",
    short: "Demo",
    help: "Practice spins on the demo machine: simulated, no prizes, no points. Playable straight away, with no 30-minute wait.",
    badge: "border-border bg-muted text-muted-foreground",
  },
} as const;
type GrantKind = keyof typeof GRANT_KINDS;

function GrantsPanel() {
  const qc = useQueryClient();
  const grant = useServerFn(adminGrant);
  const setLevel = useServerFn(adminSetLevel);
  const [g, setG] = useState<{ email: string; spins: number; kind: GrantKind; points: number; note: string }>({ email: "", spins: 1, kind: "real", points: 0, note: "" });
  const [busy, setBusy] = useState(false);
  const [lv, setLv] = useState({ tokenId: "", level: "" });
  // Paid-equivalent spins are real on-chain draws, so they can only be played while the draw is switched on.
  const { data: drawOpen } = useQuery({
    queryKey: ["grant-draw-open"],
    queryFn: async () => {
      const { data: row } = await supabase.from("app_config").select("value").eq("key", "vrf").maybeSingle();
      const v = (row?.value ?? {}) as { enabled?: boolean; contract?: string };
      return !!v.enabled && /^0x[0-9a-fA-F]{40}$/.test(v.contract ?? "");
    },
  });
  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded border border-border bg-card p-4">
          <h3 className="font-bold">Grant spins / adjust points</h3>
          <Input placeholder="user email" type="email" value={g.email} onChange={(e) => setG({ ...g, email: e.target.value })} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Spin type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(GRANT_KINDS) as GrantKind[]).map((k) => (
                <label
                  key={k}
                  className={`flex cursor-pointer gap-2 rounded border p-3 text-left text-sm ${g.kind === k ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <input type="radio" name="grant-kind" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={g.kind === k} onChange={() => setG({ ...g, kind: k })} />
                  <span>
                    <b>{GRANT_KINDS[k].label}</b>
                    <span className="mt-1 block text-xs text-muted-foreground">{GRANT_KINDS[k].help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {g.kind === "real" && drawOpen === false && (
            <p className="rounded border border-destructive/60 bg-destructive/10 p-2 text-left text-xs">
              The on-chain draw is switched off right now, so players will see paid-equivalent spins as “saved” but can’t
              spin them until you turn it on (Chainlink VRF tab). Demo spins work straight away.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-left text-xs text-muted-foreground">
              Spins
              <Input type="number" min={0} max={100} value={g.spins} onChange={(e) => setG({ ...g, spins: +e.target.value })} />
            </label>
            <label className="text-left text-xs text-muted-foreground">
              Points (+/-)
              <Input type="number" value={g.points} onChange={(e) => setG({ ...g, points: +e.target.value })} />
            </label>
          </div>
          <Input placeholder="reason / note (shown in the grant log)" value={g.note} onChange={(e) => setG({ ...g, note: e.target.value })} />
          <Button
            disabled={busy || !g.email || (g.spins <= 0 && g.points === 0)}
            onClick={async () => {
              setBusy(true);
              try {
                await grant({ data: g });
                toast.success(g.spins > 0 ? `Granted ${g.spins} ${GRANT_KINDS[g.kind].label.toLowerCase()} spin${g.spins === 1 ? "" : "s"} — usable now` : "Points adjusted");
                void qc.invalidateQueries({ queryKey: ["spin-grants"] });
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Applying…" : "Apply"}
          </Button>
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
      <GrantLog />
    </div>
  );
}

function GrantLog() {
  const list = useServerFn(adminListGrants);
  const { data: res, error, isFetching, refetch } = useQuery({ queryKey: ["spin-grants"], queryFn: () => list() });
  const del = useServerFn(adminDeleteGrant);
  const [deleting, setDeleting] = useState<string | null>(null);
  const data = res?.rows;
  const [filter, setFilter] = useState<"all" | GrantKind>("all");
  const rows = (data ?? []).filter((r) => filter === "all" || r.kind === filter);
  const totals = (k: GrantKind) => {
    const xs = (data ?? []).filter((r) => r.kind === k);
    const granted = xs.reduce((s, r) => s + r.count, 0);
    const used = xs.reduce((s, r) => s + r.used, 0);
    return { granted, used, left: granted - used };
  };
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">Granted spins</h3>
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Loading…" : "Refresh"}</Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(Object.keys(GRANT_KINDS) as GrantKind[]).map((k) => {
          const t = totals(k);
          return (
            <div key={k} className="rounded border border-border p-3 text-left">
              <span className={`inline-block rounded border px-2 py-0.5 text-xs font-bold ${GRANT_KINDS[k].badge}`}>{GRANT_KINDS[k].label}</span>
              <p className="mt-2 text-sm">
                <b>{t.granted}</b> granted · <b>{t.used}</b> used · <b>{t.left}</b> unused
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label="Filter grants">
        {(["all", "real", "demo"] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : GRANT_KINDS[f].label}
          </Button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{(error as Error).message}</p>}
      {res?.pendingMigration && (
        <p className="mt-3 rounded border border-border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
          Grants are working and players can use them now. One database update is still waiting to be applied in Lovable
          (see Setup checklist); when it runs, every grant listed here carries over automatically.
        </p>
      )}
      {res?.pendingMigration && (
        <p className="mt-3 rounded border border-border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
          Grants are working and players can use them now. One database update is still waiting to be applied in Lovable
          (see Setup checklist); when it runs, every grant listed here carries over automatically.
        </p>
      )}
      {data && rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No grants yet.</p>}
      <ul className="mt-3 divide-y divide-border text-left text-sm">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-1 py-3 sm:grid-cols-[170px_100px_minmax(0,1fr)_minmax(130px,auto)] sm:items-center sm:gap-3">
            <span className="font-mono text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
            <span>
              <span className={`inline-block rounded border px-2 py-0.5 text-xs font-bold ${GRANT_KINDS[r.kind].badge}`}>{GRANT_KINDS[r.kind].short}</span>
            </span>
            <span className="min-w-0">
              <span className="block break-all font-medium">{r.player}</span>
              <span className="block break-words text-xs text-muted-foreground">
                {r.note || "No note"} · by {r.granted_by}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2 font-mono text-xs sm:justify-end">
              {r.used}/{r.count} used{r.count - r.used > 0 ? ` · ${r.count - r.used} left` : ""}
              {r.count - r.used > 0 && /^[0-9a-f-]{36}$/.test(r.id) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-9 px-2 py-1 text-xs text-destructive"
                  disabled={deleting === r.id}
                  onClick={async () => {
                    const left = r.count - r.used;
                    if (!window.confirm(`Delete ${left} unused ${GRANT_KINDS[r.kind].label.toLowerCase()} spin${left === 1 ? "" : "s"} granted to ${r.player}? Spins already played stay.`)) return;
                    setDeleting(r.id);
                    try {
                      const { removed } = await del({ data: { grantId: r.id } });
                      toast.success(`Deleted ${removed} unused spin${removed === 1 ? "" : "s"}`);
                      await refetch();
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setDeleting(null);
                    }
                  }}
                >
                  {deleting === r.id ? "Deleting…" : "Delete unused"}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BoardPanel() {
  const qc = useQueryClient();
  const setMode = useServerFn(adminSetLeaderboardMode);
  const listWinners = useServerFn(adminListWinners);
  const mark = useServerFn(adminMarkDelivered);
  const { data: mode } = useLeaderboardMode();
  const [minRarity, setMinRarity] = useState<"all" | "rare" | "epic" | "legendary">("rare");
  const { data: winners, error, isFetching, refetch } = useQuery({ queryKey: ["winners", minRarity], queryFn: () => listWinners({ data: { minRarity } }) });
  const [busy, setBusy] = useState<string | null>(null);
  const switchTo = async (m: "demo" | "live") => {
    setBusy("mode");
    try {
      await setMode({ data: { mode: m } });
      toast.success(m === "demo" ? "The public leaderboard now shows demo spins" : "The public leaderboard now shows live (real) spins");
      await qc.invalidateQueries({ queryKey: ["leaderboard-mode"] });
      await qc.invalidateQueries({ queryKey: ["leaderboard"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div className="space-y-3 rounded border border-border bg-card p-4 text-left">
        <h3 className="font-bold">Public leaderboard</h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Leaderboard mode">
          {(["live", "demo"] as const).map((m) => (
            <Button key={m} variant={mode === m ? "default" : "outline"} aria-pressed={mode === m} disabled={!!busy} onClick={() => void switchTo(m)}>
              {m === "live" ? "Live" : "Demo"}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          <b>Live</b>: points from real spins drawn by Chainlink: purchased, paid-equivalent grants and NFT burns, plus your point adjustments.{" "}
          <b>Demo</b>: points from signed-in players' demo spins (the free spin every 30 minutes and granted demo spins).
        </p>
        <p className="text-xs text-muted-foreground">Showing now:</p>
        <Leaderboard limit={10} />
      </div>
      <div className="space-y-3 rounded border border-border bg-card p-4 text-left">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Prize winners</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-10 rounded border border-border bg-background px-2 text-sm" value={minRarity} onChange={(e) => setMinRarity(e.target.value as typeof minRarity)}>
              <option value="all">All prizes</option>
              <option value="rare">Rare and up</option>
              <option value="epic">Epic and up</option>
              <option value="legendary">Legendary only</option>
            </select>
            <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Loading…" : "Refresh"}</Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Real prizes drawn by Chainlink. Mark each one delivered once you've handed it over.</p>
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {winners && !winners.length && <p className="text-sm text-muted-foreground">No winners yet.</p>}
        <ul className="divide-y divide-border text-sm">
          {winners?.map((w) => (
            <li key={w.id} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
              <span className="min-w-0">
                <b>{w.prize}</b> <span className="text-xs uppercase text-muted-foreground">{w.rarity}</span>
                <span className="block break-all text-xs text-muted-foreground">
                  {w.player} · {new Date(w.at).toLocaleString()}
                  {w.tx && <> · <a className="underline" href={w.tx} target="_blank" rel="noreferrer">draw ↗</a></>}
                </span>
              </span>
              {w.trackable ? (
                <Button
                  size="sm"
                  variant={w.delivered_at ? "outline" : "default"}
                  disabled={busy === w.id}
                  onClick={async () => {
                    setBusy(w.id);
                    try {
                      await mark({ data: { spinId: w.id, delivered: !w.delivered_at } });
                      await refetch();
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {w.delivered_at ? `Delivered ${new Date(w.delivered_at).toLocaleDateString()} · undo` : "Mark delivered"}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Delivery tracking turns on after the database update</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AuditPanel() {
  const { data } = useQuery({ queryKey: ["audit"], queryFn: async () => (await supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(200)).data ?? [] });
  return (
    <div className="mt-4 rounded border border-border bg-card font-mono text-xs">
      {data?.map((a) => (
        <div key={a.id} className="grid gap-1 border-b border-border px-4 py-2 text-left sm:grid-cols-[170px_160px_1fr] sm:gap-3">
          <span className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
          <span className="text-primary">{a.action}</span>
          <span className="break-all sm:truncate">{JSON.stringify(a.details)}</span>
        </div>
      ))}
    </div>
  );
}
