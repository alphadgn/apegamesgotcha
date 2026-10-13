import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { SwipeToDelete } from "@/components/SwipeToDelete";
import { toast } from "sonner";
import { usePrizeImageUrl } from "@/components/PrizeImage";
import { supabase } from "@/integrations/supabase/client";
import { adminUpdateConfig, adminUpsertPrize, adminDeletePrize, adminGrant, adminListGrants, adminDeleteGrant, adminSetLeaderboardMode, adminListWinners, adminMarkDelivered, adminSetLevel, adminVrfStatus, adminVrfSetup, adminVrfTopUp, adminVrfSwitch, adminVrfSubscription, adminPurchaseSwitch, adminListPurchases, adminPublishPool, adminSettleDraws, adminSetupStatus, adminRefreshEventInfo, adminEventInfoPages, adminPoolStatus } from "@/lib/app.functions";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Leaderboard, useLeaderboardMode } from "@/components/Leaderboard";
import { adminListIrlClaims, adminUpdateClaim, type ClaimStatus } from "@/lib/claims.functions";
import { LOW_STOCK_WARNING, poolStatus, RESTOCK_MESSAGE, type PoolPrize } from "@/lib/prize-pool";
import { superDeleteAccount, superListAccounts, superSetRole, superUpdateAccount, type AccountRow } from "@/lib/users.functions";
import { Avatar } from "@/components/Avatar";
import { sortPrizes } from "@/lib/prize-order";
import { ConfirmHost, confirmAction } from "@/components/ConfirmAction";
import { PagePending } from "@/components/PagePending";
import { GiftCertificatesPanel, VendorsPanel } from "@/components/admin/CertificatePanels";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin — ApeGames Gotcha" },
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
  const { isAdmin, isSuperAdmin, loading } = useAuth();
  if (loading) return <PagePending />;
  if (!isAdmin) return <main className="mx-auto max-w-3xl px-4 py-16 text-muted-foreground">Admins only.</main>;
  // Promoted admins: Setup checklist, Prizes & odds, Grants & levels, Leaderboard & prizes.
  // The super admin also gets Configuration, Chainlink VRF, Audit log and Admins (all enforced on the server).
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <h1 className="text-3xl font-bold sm:text-4xl">{isSuperAdmin ? "Super admin console" : "Admin console"}</h1>
      <ConfirmHost />
      <AdminPoolWarning />
      <Tabs defaultValue="setup" className="mt-6">
        <TabsList className="admin-tabs h-auto flex-wrap justify-center gap-2 p-1">
          <TabsTrigger value="setup">Setup checklist</TabsTrigger>
          <TabsTrigger value="claims">IRL claims</TabsTrigger>
          <TabsTrigger value="certs">Gift certificates</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="config">Configuration</TabsTrigger>}
          <TabsTrigger value="prizes">Prizes & odds</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="vrf">Chainlink VRF</TabsTrigger>}
          <TabsTrigger value="grants">Grants & levels</TabsTrigger>
          <TabsTrigger value="board">Leaderboard & prizes</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="admins">Admins</TabsTrigger>}
          {isSuperAdmin && <TabsTrigger value="vendors">Vendors</TabsTrigger>}
          {isSuperAdmin && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="setup"><SetupPanel /></TabsContent>
        <TabsContent value="claims"><IrlClaimsPanel /></TabsContent>
        <TabsContent value="certs"><GiftCertificatesPanel /></TabsContent>
        {isSuperAdmin && <TabsContent value="config"><ConfigPanel /></TabsContent>}
        <TabsContent value="prizes"><PrizesPanel /></TabsContent>
        {isSuperAdmin && <TabsContent value="vrf"><VrfPanel /></TabsContent>}
        <TabsContent value="grants"><GrantsPanel /></TabsContent>
        <TabsContent value="board"><BoardPanel /></TabsContent>
        {isSuperAdmin && <TabsContent value="admins"><AccountsPanel /></TabsContent>}
        {isSuperAdmin && <TabsContent value="vendors"><VendorsPanel /></TabsContent>}
        {isSuperAdmin && <TabsContent value="audit"><AuditPanel /></TabsContent>}
      </Tabs>
    </main>
  );
}

/** Admin-only warning on every tab while the prize pool is at 20% or less (players only see the 0% hold). */
function AdminPoolWarning() {
  const fn = useServerFn(adminPoolStatus);
  const { data } = useQuery({ queryKey: ["admin-pool-status"], queryFn: () => fn(), refetchInterval: 60_000 });
  if (!data?.lowStock) return null;
  return (
    <div className="mt-4">
      <PoolLevel pool={data} compact />
    </div>
  );
}

const ROLE_LABEL = { super: "Super admin", admin: "Admin", user: "Player" } as const;

/** Super admin only: promote any account to admin, make admins players again, rename or delete accounts. */
function AccountsPanel() {
  const list = useServerFn(superListAccounts);
  const setRole = useServerFn(superSetRole);
  const rename = useServerFn(superUpdateAccount);
  const remove = useServerFn(superDeleteAccount);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["accounts", search],
    queryFn: () => list({ data: { query: search } }),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  /** Asks first, then runs the action. Resolves true when it was done. */
  const act = async (key: string, ask: Parameters<typeof confirmAction>[0], fn: () => Promise<unknown>, ok: string) => {
    if (!(await confirmAction(ask))) return false;
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await refetch();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const nameOf = (r: AccountRow) => r.displayName ?? r.email ?? "this account";

  const admins = (data?.rows ?? []).filter((r) => r.role !== "user");
  const players = (data?.rows ?? []).filter((r) => r.role === "user");

  const row = (r: AccountRow) => (
    <li key={r.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar path={r.avatarPath} name={r.displayName ?? r.email} size={36} />
        <div className="min-w-0">
          {editing?.id === r.id ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = editing.name.trim();
                if (name === (r.displayName ?? "")) return setEditing(null);
                void act(
                  `rename:${r.id}`,
                  { title: "Change this username?", description: `"${r.displayName ?? "(no username)"}" will be renamed to "${name}". The new name shows on the leaderboard.`, confirmLabel: "Rename" },
                  () => rename({ data: { userId: r.id, displayName: name } }),
                  "Username saved",
                ).then((done) => done && setEditing(null));
              }}
            >
              <Input className="h-9 w-48" value={editing.name} maxLength={24} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} autoFocus />
              <Button size="sm" type="submit" disabled={busy === `rename:${r.id}`}>Save</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </form>
          ) : (
            <p className="truncate font-bold">
              {r.displayName ?? "(no username)"}{" "}
              <span className={`ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${r.role === "user" ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground"}`}>
                {ROLE_LABEL[r.role]}
              </span>
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {r.email ?? r.id}
            {r.lastSignInAt ? ` · last sign-in ${new Date(r.lastSignInAt).toLocaleDateString()}` : ""}
          </p>
        </div>
      </div>
      {r.role === "super" ? (
        <span className="text-xs text-muted-foreground">Can't be changed here</span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {r.role === "user" ? (
            <Button size="sm" disabled={!!busy} onClick={() => void act(`role:${r.id}`, { title: `Promote ${nameOf(r)} to admin?`, description: "They'll get Setup checklist, Prizes & odds, Grants & levels and Leaderboard & prizes. You stay the only super admin.", confirmLabel: "Make admin" }, () => setRole({ data: { userId: r.id, role: "admin" } }), "Promoted to admin")}>
              Make admin
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act(`role:${r.id}`, { title: `Demote ${nameOf(r)} to player?`, description: "They lose access to the admin console straight away. Their account, spins and points stay.", confirmLabel: "Make player", destructive: true }, () => setRole({ data: { userId: r.id, role: "user" } }), "Now a regular player")}>
              Make player
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setEditing({ id: r.id, name: r.displayName ?? "" })}>
            Edit name
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={!!busy}
            onClick={() =>
              void act(
                `del:${r.id}`,
                { title: `Delete ${nameOf(r)}'s account for good?`, description: "This removes their sign-in, username, picture, wallets, points and unused spins. Spin and purchase history stays. This can't be undone.", confirmLabel: "Delete for good", destructive: true },
                () => remove({ data: { userId: r.id } }),
                "Account deleted",
              )
            }
          >
            {busy === `del:${r.id}` ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <div className="mt-4 grid gap-4">
      <div className="rounded border border-border bg-card p-4 text-left">
        <h3 className="font-bold">Admins</h3>
        <p className="text-sm text-muted-foreground">
          Promoted admins can use Setup checklist, Prizes & odds, Grants & levels and Leaderboard & prizes. Only you (the super
          admin) can use Configuration, Chainlink VRF, the Audit log and this tab.
        </p>
        {error && <p className="mt-2 text-sm text-destructive">{(error as Error).message}</p>}
        <ul className="divide-y divide-border">{admins.map(row)}</ul>
      </div>
      <div className="rounded border border-border bg-card p-4 text-left">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Players {data ? <span className="font-mono text-sm text-muted-foreground">({data.total} accounts)</span> : null}</h3>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(query); }}>
            <Input className="h-10 w-56" placeholder="Search email, username or ID" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button size="sm" type="submit" variant="outline" disabled={isFetching}>{isFetching ? "…" : "Search"}</Button>
          </form>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Deleting an account removes its sign-in, username, picture, wallets (so they can be linked again), points and unused spins.
          Spin and purchase history stays for the records. This can't be undone.
        </p>
        {data && !players.length && <p className="mt-3 text-sm text-muted-foreground">No players match.</p>}
        <ul className="divide-y divide-border">{players.map(row)}</ul>
      </div>
    </div>
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
    if (!(await confirmAction({ title: "Refresh ApeFest info now?", description: "Fetches the BAYC pages again with Firecrawl (uses Firecrawl credits) and replaces what the guide reads.", confirmLabel: "Refresh" }))) return;
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
        let value: unknown;
        try { value = JSON.parse(text); } catch { toast.error("That isn't valid JSON — check commas, quotes and brackets."); return; }
        if (!(await confirmAction({ title: `Save a new version of ${row.key}?`, description: "The app starts using these settings straight away.", confirmLabel: "Save" }))) return;
        try { await save({ data: { key: row.key, value } }); toast.success(`Saved ${row.key}`); qc.invalidateQueries({ queryKey: ["config"] }); }
        catch (e) { toast.error((e as Error).message); }
      }}>Save new version</Button>
    </div>
  );
}

type Prize = { id?: string; name: string; rarity: "common" | "rare" | "epic" | "legendary"; weight: number; points: number; inventory: number | null; active: boolean; image_url?: string | null; is_physical?: boolean };

/** Prize images live in a private bucket; `image_url` stores the file path and is shown via a signed link. */
function PrizeImage({ path, onChange }: { path?: string | null | undefined; onChange: (p: string | null) => void }) {
  const url = usePrizeImageUrl(path);
  const [busy, setBusy] = useState(false);
  return (
    <label className="relative flex h-12 w-12 cursor-pointer items-center justify-center overflow-hidden rounded border border-dashed border-border bg-background text-[10px] text-muted-foreground" title={path ? "Replace image" : "Upload image"}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : busy ? "…" : "+ img"}
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) { toast.error("Use a JPEG, PNG, WebP or GIF picture"); return; }
        if (f.size > 5 * 1024 * 1024) { toast.error("Image must be under 5 MB"); return; }
        setBusy(true);
        const ext = f.name.split(".").pop()?.toLowerCase() || "png";
        const p = `${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from("prize-images").upload(p, f, { contentType: f.type });
        setBusy(false);
        if (error) { toast.error(error.message); return; }
        onChange(p);
        toast.info("Image uploaded — press Save to keep it");
      }} />
    </label>
  );
}

/** Admin-only prize pool level: warning from 20% left; players are paused (pop-up) only at 0%. */
function PoolLevel({ pool, compact = false }: { pool: ReturnType<typeof poolStatus>; compact?: boolean }) {
  const pct = Math.round(pool.ratio * 100);
  const tone = pool.onHold
    ? "border-destructive bg-destructive/10"
    : pool.lowStock
      ? "border-amber-400 bg-amber-400/10"
      : "border-border";
  return (
    <div className={`mb-3 rounded border p-3 text-sm ${tone}`} role={pool.lowStock ? "alert" : undefined}>
      <b>{pool.onHold ? "⛔ Prize pool empty" : pool.lowStock ? "⚠️ Prize pool low" : "Prize pool"}:</b> {pool.remaining} of{" "}
      {pool.stocked} limited-stock prizes left ({pct}%).{" "}
      {pool.onHold ? (
        <span className="text-destructive">
          Players see "{RESTOCK_MESSAGE}" and live buys & spins are paused. Restock: raise the Stock of your limited prizes
          in Prizes & odds and Save (the super admin then publishes the prize pool on-chain); everything reopens by itself.
        </span>
      ) : pool.lowStock ? (
        <span>
          Only admins see this warning (from {Math.round(LOW_STOCK_WARNING * 100)}% left). Players are paused when it reaches
          0%{compact ? "." : ": raise the Stock of your limited prizes and Save to restock now."}
        </span>
      ) : (
        <span className="text-muted-foreground">
          Admins are warned at {Math.round(LOW_STOCK_WARNING * 100)}% left; at 0% live buys & spins pause for players until you
          restock.
        </span>
      )}
    </div>
  );
}

function PrizesPanel() {
  const qc = useQueryClient();
  const save = useServerFn(adminUpsertPrize);
  const del = useServerFn(adminDeletePrize);
  const { data } = useQuery({ queryKey: ["prizes-admin"], queryFn: async () => (await supabase.from("prizes").select("*").order("created_at")).data ?? [] });
  const [rows, setRows] = useState<Prize[]>([]);
  // Sorted when loaded or saved (not while typing): legendary, epic, rare, common; within a rarity the highest
  // dollar value in the name ("… $50") first, then more points, then name. Unsaved new rows stay at the bottom.
  useEffect(() => { if (data) setRows(sortPrizes(data as Prize[])); }, [data]);
  const total = rows.filter((r) => r.active && (r.inventory == null || r.inventory > 0)).reduce((s, r) => s + r.weight, 0);
  const upd = (i: number, p: Partial<Prize>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const cols = "grid min-w-[920px] grid-cols-[56px_2fr_1fr_1fr_1fr_1fr_60px_50px_50px_70px_70px] gap-2";
  // Saved stock (not unsaved edits): at 20% left or less, live buys & spins pause until a restock.
  const pool = poolStatus(((data ?? []) as PoolPrize[]));
  return (
    <div className="mt-4 overflow-x-auto rounded border border-border bg-card p-4">
      {pool.stocked > 0 && <PoolLevel pool={pool} />}
      <p className="mb-2 text-xs text-muted-foreground sm:hidden">Swipe sideways to see every column.</p>
      <div className={`${cols} font-mono text-xs uppercase text-muted-foreground`}>
        <span>Image</span><span>Name</span><span>Rarity</span><span>Weight</span><span>Odds</span><span>Points</span><span>Stock</span><span>IRL</span><span>Active</span><span /><span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id ?? i} className={`mt-2 ${cols} items-center`}>
          <PrizeImage path={r.image_url} onChange={(p) => upd(i, { image_url: p })} />
          <div>
            <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
            {r.is_physical && <span className="mt-1 inline-block rounded bg-primary/20 px-1.5 text-[10px] uppercase text-primary">IRL physical prize claim</span>}
          </div>
          <select className="h-9 rounded border border-input bg-background px-2 text-sm" value={r.rarity} onChange={(e) => upd(i, { rarity: e.target.value as Prize["rarity"] })}>
            {["common", "rare", "epic", "legendary"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <Input type="number" placeholder="0" value={r.weight || ""} onChange={(e) => upd(i, { weight: +e.target.value })} />
          <span className="font-mono text-sm">{total && r.active ? ((r.weight / total) * 100).toFixed(2) : "0"}%</span>
          <Input type="number" placeholder="0" value={r.points || ""} onChange={(e) => upd(i, { points: +e.target.value })} />
          <Input placeholder="∞" value={r.inventory ?? ""} onChange={(e) => upd(i, { inventory: e.target.value === "" ? null : +e.target.value })} />
          <input type="checkbox" aria-label="IRL physical prize" checked={!!r.is_physical} onChange={(e) => upd(i, { is_physical: e.target.checked })} />
          <input type="checkbox" aria-label="Active" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} />
          <Button size="sm" onClick={async () => {
            if (!(await confirmAction({ title: r.id ? `Save changes to "${r.name}"?` : `Add the prize "${r.name}"?`, description: "Changes the prize pool players draw from. If the draw is on-chain, publish the prize pool afterwards (Chainlink VRF tab).", confirmLabel: "Save" }))) return;
            try { await save({ data: { ...r, image_url: r.image_url ?? null, is_physical: !!r.is_physical } }); toast.success("Saved"); qc.invalidateQueries({ queryKey: ["prizes-admin"] }); } catch (e) { toast.error((e as Error).message); }
          }}>Save</Button>
          <Button size="sm" variant="destructive" onClick={async () => {
            if (!r.id) { setRows(rows.filter((_, j) => j !== i)); return; }
            if (!(await confirmAction({ title: `Delete the prize "${r.name}"?`, description: "If players already won it or it's on-chain, it's switched off instead of deleted.", confirmLabel: "Delete", destructive: true }))) return;
            try {
              const res = await del({ data: { id: r.id } });
              if (res.deleted) toast.success("Prize deleted");
              else toast.info("Players already won this prize or it's on-chain, so it was switched off instead of deleted.");
              qc.invalidateQueries({ queryKey: ["prizes-admin"] });
            } catch (e) { toast.error((e as Error).message); }
          }}>Delete</Button>
        </div>
      ))}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "New prize", rarity: "common", weight: 1, points: 0, inventory: null, active: false, image_url: null, is_physical: false }])}>Add prize</Button>
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "IRL physical prize claim", rarity: "legendary", weight: 1, points: 0, inventory: 1, active: false, image_url: null, is_physical: true }])}>Add IRL physical prize</Button>
      </div>
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
  const act = async (k: string, ask: Parameters<typeof confirmAction>[0], fn: () => Promise<string>) => {
    if (!(await confirmAction(ask))) return;
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
        <p className="mt-1 text-sm text-muted-foreground">Every capsule is drawn by the GotchaVRF contract using Chainlink VRF. Set it up with the "Set up" button above (Base, chain 8453).</p>
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
          <Button className="mt-2" disabled={!!busy} onClick={() => act("publish", { title: "Publish the prize pool on-chain?", description: "Sends the current prize weights and stock to the draw contract (an on-chain transaction paid by the operator wallet).", confirmLabel: "Publish" }, async () => { const r = await publish(); return `Published (${r.txHash.slice(0, 10)}…)`; })}>{busy === "publish" ? "Publishing…" : "Publish prize pool"}</Button>
        </div>
        <div>
          <h3 className="font-bold">Settle pending draws</h3>
          <p className="mt-1 text-sm text-muted-foreground">Records results Chainlink has delivered for players who left mid-draw, and returns credits for requests that never reached the chain.</p>
          <Button variant="secondary" className="mt-2" disabled={!!busy} onClick={() => act("settle", { title: "Settle pending draws now?", description: "Records results Chainlink has delivered and returns spins for requests that never reached the chain.", confirmLabel: "Settle" }, async () => { const r = await settle(); return `Settled ${r.before - r.after} of ${r.before}`; })}>{busy === "settle" ? "Settling…" : "Settle now"}</Button>
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
  const { data: sub, error: loadError, isFetching: checking, refetch } = useQuery({ queryKey: ["vrf-sub"], queryFn: () => subFn() });
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
        Operator wallet: <span className="break-all font-mono">{sub?.operator ?? (checking ? "Checking…" : loadError ? "Could not check wallet" : "not set — add the secret first")}</span>
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
          className="min-h-11 w-full sm:w-auto"
          disabled={!!busy || enabled || (!loadError && !sub?.operator)}
          onClick={async () => {
            if (!(await confirmAction({ title: "Set up the on-chain draw?", description: `Creates a Chainlink VRF subscription on ${network === "base" ? "Base (real ETH)" : network === "base-sepolia" ? "Base Sepolia (test)" : "your custom network"}, funds it with ${fundEth} ETH from the operator wallet and deploys the draw contract.`, confirmLabel: "Set up" }))) return;
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
      {(subError || loadError) && <div role="alert" className="space-y-2">
        <p className="break-words text-sm text-destructive">{subError || (loadError as Error)?.message}</p>
        <Button variant="outline" disabled={checking} onClick={() => void refetch()}>Retry wallet check</Button>
      </div>}
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
              if (!(await confirmAction({ title: `Add ${topEth} ETH to the subscription?`, description: "Sends ETH from the operator wallet to the Chainlink VRF subscription. This can't be undone.", confirmLabel: "Send ETH" }))) return;
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
            if (!(await confirmAction(enabled
              ? { title: "Switch real spins off?", description: "Players can't play live spins until you switch them back on. Their spins are kept.", confirmLabel: "Switch off", destructive: true }
              : { title: "Switch real spins on?", description: "Every live spin is then drawn on-chain by Chainlink VRF and paid from the subscription.", confirmLabel: "Switch on" }))) return;
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
            if (!(await confirmAction(on
              ? { title: "Switch purchases off?", description: "Players can't buy spins with APE until you switch purchases back on.", confirmLabel: "Switch off", destructive: true }
              : { title: "Switch purchases on?", description: "Refill starts charging players APE and adding spins.", confirmLabel: "Switch on" }))) return;
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

/** An error's message, with raw validation output (a JSON list of issues) turned into plain sentences. */
function friendlyError(e: unknown) {
  const msg = (e as Error)?.message ?? String(e);
  try {
    const issues = JSON.parse(msg) as { message?: string }[];
    if (Array.isArray(issues) && issues.length) return issues.map((i) => i.message ?? "Invalid value").join(" · ");
  } catch {
    /* not JSON: already a plain message */
  }
  return msg;
}

function GrantsPanel() {
  const qc = useQueryClient();
  const grant = useServerFn(adminGrant);
  const setLevel = useServerFn(adminSetLevel);
  const [g, setG] = useState<{ who: string; spins: number; kind: GrantKind; points: number; note: string }>({ who: "", spins: 1, kind: "real", points: 0, note: "" });
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
          <label className="block text-left text-xs text-muted-foreground">
            Player
            <Input
              placeholder="username, email or wallet address"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={g.who}
              onChange={(e) => setG({ ...g, who: e.target.value })}
            />
          </label>
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
              <Input type="number" min={0} max={100} placeholder="0" value={g.spins || ""} onChange={(e) => setG({ ...g, spins: +e.target.value })} />
            </label>
            <label className="text-left text-xs text-muted-foreground">
              Points (+/-)
              <Input type="number" placeholder="0" value={g.points || ""} onChange={(e) => setG({ ...g, points: +e.target.value })} />
            </label>
          </div>
          <Input placeholder="reason / note (shown in the grant log)" value={g.note} onChange={(e) => setG({ ...g, note: e.target.value })} />
          <Button
            disabled={busy || !g.who.trim() || (g.spins <= 0 && g.points === 0)}
            onClick={async () => {
              const who = g.who.trim();
              const what = [
                g.spins > 0 ? `${g.spins} ${GRANT_KINDS[g.kind].label.toLowerCase()} spin${g.spins === 1 ? "" : "s"}` : "",
                g.points !== 0 ? `${g.points > 0 ? "+" : ""}${g.points} points` : "",
              ].filter(Boolean).join(" and ");
              if (!(await confirmAction({ title: `Give ${what} to ${who}?`, description: g.note ? `Note: ${g.note}` : "Usable straight away.", confirmLabel: "Grant" }))) return;
              setBusy(true);
              try {
                const res = await grant({ data: { ...g, who } });
                setG({ who: "", spins: 0, kind: g.kind, points: 0, note: "" }); // cleared so it can't be granted twice by accident
                const to = res?.player ? ` to ${res.player}` : "";
                toast.success(g.spins > 0 ? `Granted ${g.spins} ${GRANT_KINDS[g.kind].label.toLowerCase()} spin${g.spins === 1 ? "" : "s"}${to} — usable now` : `Points adjusted${to ? ` for ${res.player}` : ""}`);
                void qc.invalidateQueries({ queryKey: ["spin-grants"] });
              } catch (e) {
                toast.error(friendlyError(e));
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
          <Button
            disabled={!lv.tokenId.trim()}
            onClick={async () => {
              const level = lv.level.trim() === "" ? null : +lv.level;
              if (!(await confirmAction({ title: level == null ? `Clear the level override for NFT #${lv.tokenId}?` : `Set NFT #${lv.tokenId} to level ${level}?`, confirmLabel: "Save" }))) return;
              try {
                await setLevel({ data: { tokenId: lv.tokenId.trim(), level } });
                toast.success("Updated");
                setLv({ tokenId: "", level: "" });
              } catch (e) {
                toast.error(friendlyError(e));
              }
            }}
          >
            Save
          </Button>
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
      {data && rows.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No grants yet.</p>}
      {rows.length > 0 && <p className="mt-3 text-left text-xs text-muted-foreground">Swipe a grant left to delete its unused spins. Only the spins are removed — never the player's account.</p>}
      <ul className="mt-3 divide-y divide-border overflow-hidden text-left text-sm">
        {rows.map((r) => {
          const left = r.count - r.used;
          const canDelete = left > 0 && /^[0-9a-f-]{36}$/.test(r.id);
          const remove = async () => {
            if (!(await confirmAction({ title: `Delete ${left} unused ${GRANT_KINDS[r.kind].label.toLowerCase()} spin${left === 1 ? "" : "s"} granted to ${r.player}?`, description: "Only the spins are removed — the account stays. Spins already played stay.", confirmLabel: "Delete spins", destructive: true }))) return false;
            setDeleting(r.id);
            try {
              const { removed } = await del({ data: { grantId: r.id } });
              toast.success(`Deleted ${removed} unused spin${removed === 1 ? "" : "s"}`);
              await refetch();
              return true;
            } catch (e) {
              toast.error((e as Error).message);
              return false;
            } finally {
              setDeleting(null);
            }
          };
          return (
            <SwipeToDelete key={r.id} enabled={canDelete && deleting !== r.id} onDelete={remove} label={deleting === r.id ? "Deleting…" : `Delete ${left} spin${left === 1 ? "" : "s"}`}>
              <div className="grid gap-1 py-3 sm:grid-cols-[170px_100px_minmax(0,1fr)_minmax(130px,auto)] sm:items-center sm:gap-3">
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
                <span className="font-mono text-xs sm:text-right">
                  {r.used}/{r.count} used{left > 0 ? ` · ${left} left` : ""}
                </span>
              </div>
            </SwipeToDelete>
          );
        })}
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
    if (m === mode) return;
    if (!(await confirmAction({ title: `Show the ${m === "live" ? "live" : "demo"} leaderboard to everyone?`, description: m === "live" ? "The public leaderboard switches to points from real spins." : "The public leaderboard switches to points from demo spins.", confirmLabel: "Switch" }))) return;
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
        <p className="text-sm text-muted-foreground">
          Real prizes drawn by Chainlink. Only physical (IRL) prizes, which are picked up or shipped, are marked delivered
          once you've handed them over (also on the IRL claims tab). Points and digital prizes need nothing.
        </p>
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
              {!w.physical ? (
                <span className="text-xs text-muted-foreground">Points / digital prize: nothing to deliver</span>
              ) : w.trackable ? (
                <Button
                  size="sm"
                  variant={w.delivered_at ? "outline" : "default"}
                  disabled={busy === w.id}
                  onClick={async () => {
                    if (!(await confirmAction(w.delivered_at
                      ? { title: `Undo "delivered" for ${w.prize}?`, description: `${w.player}'s prize goes back to not delivered.`, confirmLabel: "Undo" }
                      : { title: `Mark ${w.prize} as delivered?`, description: `Confirms you've handed it to ${w.player}.`, confirmLabel: "Mark delivered" }))) return;
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

const CLAIM_STATUSES: ClaimStatus[] = ["submitted", "approved", "shipped", "delivered", "rejected"];
const CLAIM_LABEL: Record<ClaimStatus, string> = {
  submitted: "New",
  approved: "Approved",
  shipped: "Shipped",
  delivered: "Delivered",
  rejected: "Rejected",
};
const DONE: ClaimStatus[] = ["delivered", "rejected"];

type ClaimRow = Awaited<ReturnType<typeof adminListIrlClaims>>["rows"][number];

function addressText(a: Record<string, string> | null | undefined) {
  if (!a) return "";
  return [a["line1"], a["line2"], `${a["city"] ?? ""}${a["region"] ? `, ${a["region"]}` : ""} ${a["postal"] ?? ""}`.trim(), a["country"]]
    .filter((x) => x && x.trim())
    .join("\n");
}

/**
 * IRL claims dashboard (every admin): physical prizes won in live draws, who won them, how they want them
 * (shipping address or pickup at ApeFest) and where each one is in fulfilment.
 */
function IrlClaimsPanel() {
  const list = useServerFn(adminListIrlClaims);
  const update = useServerFn(adminUpdateClaim);
  const [view, setView] = useState<"ship" | "pickup" | "unclaimed" | "done" | "all">("ship");
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["irl-claims"], queryFn: () => list(), refetchInterval: 60_000 });
  const [edits, setEdits] = useState<Record<string, { status: ClaimStatus; note: string; tracking: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const all = data?.rows ?? [];
  const open = (r: ClaimRow) => !!r.claim && !DONE.includes(r.claim.status);
  const groups = {
    ship: all.filter((r) => open(r) && r.claim!.delivery === "ship"),
    pickup: all.filter((r) => open(r) && r.claim!.delivery === "pickup"),
    unclaimed: all.filter((r) => !r.claim),
    done: all.filter((r) => !!r.claim && DONE.includes(r.claim.status)),
    all,
  };
  const rows = groups[view];

  const save = async (r: ClaimRow) => {
    const c = r.claim!;
    const e = edits[c.id];
    if (!e) return;
    const who = r.username ?? c.full_name;
    if (!(await confirmAction({ title: `Mark ${r.prize} for ${who} as "${CLAIM_LABEL[e.status]}"?`, description: "The winner sees the new status, note and tracking number.", confirmLabel: "Save" }))) return;
    setBusy(c.id);
    try {
      await update({ data: { claimId: c.id, status: e.status, adminNote: e.note, tracking: e.tracking } });
      toast.success("Claim updated");
      setEdits(({ [c.id]: _, ...rest }) => rest);
      await refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Couldn't copy — select the text instead");
    }
  };

  const tiles: { key: typeof view; label: string; count: number; tone?: string | undefined }[] = [
    { key: "ship", label: "To ship", count: groups.ship.length, tone: groups.ship.length ? "border-primary" : undefined },
    { key: "pickup", label: "Pick up at ApeFest", count: groups.pickup.length, tone: groups.pickup.length ? "border-primary" : undefined },
    { key: "unclaimed", label: "Won, not claimed yet", count: groups.unclaimed.length, tone: groups.unclaimed.length ? "border-amber-400" : undefined },
    { key: "done", label: "Delivered / closed", count: groups.done.length },
  ];

  return (
    <div className="mt-4 space-y-4 text-left">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Physical (IRL) prizes won in live draws. Winners send their details and pick shipping or pickup at ApeFest; the team
          is emailed for each claim. Any admin can fulfil them here.
        </p>
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Loading…" : "Refresh"}</Button>
      </div>
      {data && !data.ready && <p className="text-sm text-destructive">Claims turn on after the database update.</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" role="group" aria-label="Claim groups">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={view === t.key}
            onClick={() => setView(t.key)}
            className={`rounded border bg-card p-3 text-left transition ${t.tone ?? "border-border"} ${view === t.key ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100"}`}
          >
            <span className="block text-3xl font-bold">{data ? t.count : "–"}</span>
            <span className="text-xs text-muted-foreground">{t.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="text-xs underline" onClick={() => setView("all")}>Show all {all.length} IRL wins</button>

      {data && !rows.length && <p className="rounded border border-border bg-card p-4 text-sm text-muted-foreground">Nothing here.</p>}
      <ul className="grid gap-3 lg:grid-cols-2">
        {rows.map((r) => {
          const c = r.claim;
          const e = c ? (edits[c.id] ?? { status: c.status, note: c.admin_note ?? "", tracking: c.tracking ?? "" }) : null;
          const setE = (patch: Partial<NonNullable<typeof e>>) => c && e && setEdits({ ...edits, [c.id]: { ...e, ...patch } });
          const addr = c?.delivery === "ship" ? addressText(c.address) : "";
          const label = [c?.full_name, addr].filter(Boolean).join("\n");
          return (
            <li key={r.spin_id} className="space-y-3 rounded border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold">{r.prize} <span className="text-xs uppercase text-muted-foreground">{r.rarity}</span></p>
                  <p className="break-all text-sm">
                    <b>{r.username ?? "(no username)"}</b> <span className="text-muted-foreground">· {r.player}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">Won {new Date(r.won_at).toLocaleString()}</p>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${!c ? "bg-amber-400/20 text-amber-300" : DONE.includes(c.status) ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground"}`}>
                  {!c ? "Not claimed" : CLAIM_LABEL[c.status]}
                </span>
              </div>

              {!c ? (
                <p className="text-sm text-muted-foreground">The winner hasn't sent their details yet. They see a "Claim your IRL prize" prompt on My Machine.</p>
              ) : (
                <>
                  <div className="grid gap-2 rounded bg-muted/40 p-3 text-sm sm:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">Recipient</p>
                      <p className="font-bold">{c.full_name}</p>
                      <a className="block break-all underline" href={`mailto:${c.email}`}>{c.email}</a>
                      {c.phone && <a className="block underline" href={`tel:${c.phone}`}>{c.phone}</a>}
                    </div>
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">{c.delivery === "ship" ? "Ship to" : "Delivery"}</p>
                      {c.delivery === "ship" ? (
                        addr ? <p className="whitespace-pre-line">{addr}</p> : <p className="text-destructive">No address given</p>
                      ) : (
                        <p className="font-bold">Pick up at ApeFest Charleston</p>
                      )}
                    </div>
                    {c.notes && <p className="sm:col-span-2"><span className="text-xs uppercase text-muted-foreground">Winner's note: </span>{c.notes}</p>}
                    {c.delivery === "ship" && addr && (
                      <div className="sm:col-span-2">
                        <Button size="sm" variant="outline" onClick={() => void copy(label, "Shipping label")}>Copy shipping label</Button>
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs text-muted-foreground">
                      Status
                      <select className="mt-1 h-10 w-full rounded border border-border bg-background px-2 text-sm text-foreground" value={e!.status} onChange={(ev) => setE({ status: ev.target.value as ClaimStatus })}>
                        {CLAIM_STATUSES.map((st) => <option key={st} value={st}>{CLAIM_LABEL[st]}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Tracking number
                      <Input className="mt-1" placeholder="optional" value={e!.tracking} onChange={(ev) => setE({ tracking: ev.target.value })} maxLength={200} />
                    </label>
                    <label className="text-xs text-muted-foreground sm:col-span-2">
                      Note to the winner
                      <Input className="mt-1" placeholder="optional" value={e!.note} onChange={(ev) => setE({ note: ev.target.value })} maxLength={1000} />
                    </label>
                  </div>
                  <Button size="sm" disabled={busy === c.id || !edits[c.id]} onClick={() => void save(r)}>{busy === c.id ? "Saving…" : "Save"}</Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
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

