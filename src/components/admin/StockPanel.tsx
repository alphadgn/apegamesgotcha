// Admin → Stock certificates (every admin; the chain settings are the super admin's). See stock.functions.ts.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { adminRetryStock, adminSetStockConfig, adminSetStockPrize, adminStockOverview, type StockStatus } from "@/lib/stock.functions";
import { useAuth } from "@/hooks/useAuth";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const eth = (wei: string | null) => (wei == null ? "—" : (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(6));
const parseIds = (t: string) => t.split(/[\s,;]+/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean);

const STATUS: Record<StockStatus, string> = {
  unclaimed: "Winner hasn't chosen",
  emailed: "Claim link emailed",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
};

type Overview = Extract<Awaited<ReturnType<typeof adminStockOverview>>, { ready: true }>;

export function StockCertificatesPanel() {
  const fn = useServerFn(adminStockOverview);
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["admin-stock"], queryFn: () => fn(), refetchInterval: 60_000 });
  if (error) return <p className="mt-4 text-destructive">{(error as Error).message}</p>;
  if (!data) return <p className="mt-4 text-muted-foreground">Loading stock certificates…</p>;
  if (!data.ready)
    return <p className="mt-4 rounded border border-destructive p-3 text-sm">Stock certificates turn on after the database update (drizzle 0020) is applied.</p>;
  return (
    <div className="mt-4 space-y-6">
      <StatusCard data={data} onRefresh={() => void refetch()} refreshing={isFetching} />
      <SettingsCard data={data} onSaved={() => void refetch()} />
      <PrizesCard data={data} onSaved={() => void refetch()} />
      <WinsCard data={data} onChanged={() => void refetch()} />
    </div>
  );
}

function StatusCard({ data, onRefresh, refreshing }: { data: Overview; onRefresh: () => void; refreshing: boolean }) {
  const c = data.custody;
  return (
    <section className="rounded border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Stock certificates</h2>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A stock certificate is an NFT whose own wallet holds stock tokens. The custody wallet below holds the certificates; when a player
        wins one, the app sends it to the wallet they choose, or emails them a one-time claim link (account email only).
      </p>
      {data.missing.length ? (
        <p className="mt-3 rounded border border-destructive p-2 text-sm">
          Not ready to send yet. Missing: <b>{data.missing.join(", ")}</b>. Players can still choose; sending waits until this is complete.
        </p>
      ) : (
        <p className="mt-3 rounded border border-primary p-2 text-sm text-primary">Ready: certificates are sent automatically.</p>
      )}
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Custody wallet (send certificates and gas here)</dt>
          <dd className="break-all font-mono">
            {c.address ?? "Set the STOCK_SENDER_PRIVATE_KEY secret in Lovable → Secrets"}
            {c.address && (
              <button
                type="button"
                className="ml-2 text-xs underline"
                onClick={() => void navigator.clipboard.writeText(c.address!).then(() => toast.success("Address copied"))}
              >
                Copy
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Gas balance ({data.config.chain_name ?? "chain"} ETH)</dt>
          <dd className={c.gasWei === "0" ? "text-destructive" : ""}>{eth(c.gasWei)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Collection</dt>
          <dd>{c.collection ?? (data.config.contract ? short(data.config.contract) : "—")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">RPC</dt>
          <dd>{data.hasPrivateRpc ? "Private (STOCK_RPC_URL secret)" : data.config.rpc_url ? "From settings below" : "—"}</dd>
        </div>
      </dl>
      {c.error && <p className="mt-2 text-sm text-destructive">{c.error}</p>}
    </section>
  );
}

function SettingsCard({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const { isSuperAdmin } = useAuth();
  const save = useServerFn(adminSetStockConfig);
  const [f, setF] = useState({ chain_id: "", chain_name: "", rpc_url: "", explorer_url: "", contract: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = data.config;
    setF({
      chain_id: c.chain_id ? String(c.chain_id) : "",
      chain_name: c.chain_name ?? "",
      rpc_url: c.rpc_url ?? "",
      explorer_url: c.explorer_url ?? "",
      contract: c.contract ?? "",
    });
  }, [data.config]);
  const field = (k: keyof typeof f, label: string, placeholder: string, hint?: string) => (
    <label className="block text-sm">
      {label}
      <Input
        value={f[k]}
        disabled={!isSuperAdmin}
        placeholder={placeholder}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        className="mt-1 font-mono"
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
  const submit = async () => {
    const id = f.chain_id.trim() ? Number(f.chain_id) : null;
    if (id != null && (!Number.isInteger(id) || id <= 0)) { toast.error("The chain ID is a whole number"); return; }
    if (f.contract.trim() && !/^0x[0-9a-fA-F]{40}$/.test(f.contract.trim())) { toast.error("The contract is a 0x… address"); return; }
    if (
      !(await confirmAction({
        title: "Save the stock certificate settings?",
        description: "Certificates are sent on this chain from this contract. Changing the contract later means existing wins need new certificates.",
        confirmLabel: "Save settings",
      }))
    )
      return;
    setBusy(true);
    try {
      await save({
        data: {
          chain_id: id,
          chain_name: f.chain_name.trim() || null,
          rpc_url: f.rpc_url.trim() || null,
          explorer_url: f.explorer_url.trim() || null,
          contract: f.contract.trim() || null,
        },
      });
      toast.success("Settings saved");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded border bg-card p-4">
      <h3 className="text-lg font-bold">Chain and contract</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {isSuperAdmin ? "Check these values with StonkBrokers / docs.robinhood.com before saving." : "Only the super admin can change these."}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {field("chain_name", "Chain name", "Robinhood Chain")}
        {field("chain_id", "Chain ID", "4663", "Robinhood Chain mainnet is listed as 4663 — confirm before saving.")}
        {field("rpc_url", "RPC URL (https)", "https://…", "A private RPC can be set instead as the STOCK_RPC_URL secret.")}
        {field("explorer_url", "Block explorer", "https://robinhoodchain.blockscout.com")}
        {field("contract", "Stock certificate contract (ERC-721)", "0x…")}
      </div>
      {isSuperAdmin && (
        <Button className="mt-3" disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      )}
    </section>
  );
}

function PrizesCard({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const save = useServerFn(adminSetStockPrize);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const submit = async (p: Overview["prizes"][number]) => {
    const ids = parseIds(edit[p.id] ?? "");
    if (ids.some((x) => !/^[0-9]{1,78}$/.test(x))) { toast.error("Token IDs are whole numbers, separated by commas or spaces"); return; }
    if (
      !(await confirmAction({
        title: ids.length ? `Make "${p.name}" a stock certificate?` : `Make "${p.name}" a normal prize again?`,
        description: ids.length
          ? `${ids.length} certificate${ids.length === 1 ? "" : "s"} set aside for this prize. Each win gets one, sent from the custody wallet. Keep the prize's stock at or below the number of free certificates.`
          : "Wins that already have a certificate keep it.",
        confirmLabel: "Save",
        destructive: !ids.length,
      }))
    )
      return;
    setBusy(p.id);
    try {
      await save({ data: { prizeId: p.id, tokenIds: ids } });
      toast.success("Saved");
      setEdit(({ [p.id]: _, ...rest }) => rest);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded border bg-card p-4">
      <h3 className="text-lg font-bold">Prizes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        List the certificate token IDs held by the custody wallet for each prize that should be a stock certificate.
      </p>
      <ul className="mt-3 space-y-3">
        {data.prizes.map((p) => {
          const editing = p.id in edit;
          const outside = p.tokens.filter((t) => t.inCustody === false && !t.assigned);
          const short_ = p.tokens.length > 0 && p.inventory != null && p.inventory > p.free;
          return (
            <li key={p.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 font-bold">
                  {p.name} <span className="text-xs font-normal text-muted-foreground">{p.rarity}{p.active ? "" : " · inactive"}</span>
                </p>
                {p.tokens.length ? (
                  <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary">
                    Stock certificate · {p.free} free of {p.tokens.length}
                  </span>
                ) : null}
                {!editing && (
                  <Button size="sm" variant="outline" disabled={!!p.other} onClick={() => setEdit({ ...edit, [p.id]: p.tokens.map((t) => t.id).join(", ") })}>
                    {p.other ? p.other : p.tokens.length ? "Edit certificates" : "Make stock certificate"}
                  </Button>
                )}
              </div>
              {short_ && (
                <p className="mt-1 text-xs text-destructive">
                  Prize stock is {p.inventory} but only {p.free} certificate{p.free === 1 ? "" : "s"} are free: add token IDs or lower the stock.
                </p>
              )}
              {outside.length > 0 && (
                <p className="mt-1 text-xs text-destructive">
                  Not in the custody wallet: #{outside.slice(0, 10).map((t) => t.id).join(", #")}
                  {outside.length > 10 ? "…" : ""}
                </p>
              )}
              {editing && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={edit[p.id]}
                    onChange={(e) => setEdit({ ...edit, [p.id]: e.target.value })}
                    rows={3}
                    placeholder="Token IDs, e.g. 12, 13, 14"
                    className="w-full rounded border bg-background px-3 py-2 font-mono text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy === p.id} onClick={() => void submit(p)}>
                      {busy === p.id ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEdit(({ [p.id]: _, ...rest }) => rest)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WinsCard({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const retry = useServerFn(adminRetryStock);
  const [view, setView] = useState<"attention" | "all">("attention");
  const [busy, setBusy] = useState<string | null>(null);
  const attention = data.rows.filter((r) => r.status === "failed" || r.status === "sending" || !r.tokenId || r.stale);
  const shown = view === "attention" ? attention : data.rows;

  const act = async (r: Overview["rows"][number], newToken: boolean) => {
    const what =
      r.status === "sending"
        ? { title: "Check this transfer on-chain?", label: "Check" }
        : newToken
          ? { title: `Give ${r.player} another certificate of "${r.prize}"?`, label: "Give another" }
          : r.delivery === "email"
            ? { title: `Email ${r.player} a new claim link?`, label: "Send email" }
            : { title: `Send certificate #${r.tokenId} to ${short(r.toWallet)} again?`, label: "Send again" };
    if (
      !(await confirmAction({
        title: what.title,
        description:
          r.status === "sending"
            ? "Looks up the transfer and marks it sent or failed."
            : newToken
              ? "The win gets the next free certificate of its prize, then it's sent the way the winner chose (if they chose)."
              : "The certificate is sent from the custody wallet the way the winner chose.",
        confirmLabel: what.label,
      }))
    )
      return;
    setBusy(r.id);
    try {
      const res = await retry({ data: { id: r.id, newToken, origin: window.location.origin } });
      toast.success(
        res.state === "sent" ? "Sent" : res.state === "emailed" ? "Email sent" : res.state === "token" ? "New certificate assigned" : res.state === "sending" ? "On its way" : "Checked",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <section className="rounded border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">Wins</h3>
        <div className="flex gap-2">
          <Button size="sm" variant={view === "attention" ? "default" : "outline"} onClick={() => setView("attention")}>
            Needs attention ({attention.length})
          </Button>
          <Button size="sm" variant={view === "all" ? "default" : "outline"} onClick={() => setView("all")}>
            All ({data.rows.length})
          </Button>
        </div>
      </div>
      {!shown.length ? (
        <p className="mt-3 text-sm text-muted-foreground">{view === "attention" ? "Nothing needs attention." : "No stock certificates won yet."}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {shown.map((r) => (
            <li key={r.id} className="rounded border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1">
                  <b>{r.prize}</b> {r.tokenId ? `#${r.tokenId}` : <span className="text-destructive">(no certificate free)</span>} · {r.player}
                </p>
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-bold">{STATUS[r.status]}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Won {new Date(r.wonAt).toLocaleString()}
                {r.delivery === "wallet" && ` · to wallet ${short(r.toWallet)}`}
                {r.delivery === "email" && ` · by email${r.email ? ` (${r.email})` : ""}${r.toWallet ? ` → ${short(r.toWallet)}` : ""}`}
                {r.sentAt && ` · sent ${new Date(r.sentAt).toLocaleString()}`}
              </p>
              {r.stale && <p className="mt-1 text-xs text-destructive">From an earlier contract: give it another certificate.</p>}
              {r.error && r.status === "failed" && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {r.txUrl && (
                  <a className="text-xs underline" href={r.txUrl} target="_blank" rel="noreferrer">
                    Transfer ↗
                  </a>
                )}
                {r.status === "sending" && (
                  <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void act(r, false)}>
                    Check
                  </Button>
                )}
                {r.status === "failed" && r.delivery && r.tokenId && !r.stale && (
                  <Button size="sm" disabled={busy === r.id} onClick={() => void act(r, false)}>
                    {r.delivery === "email" ? "Email a new link" : "Send again"}
                  </Button>
                )}
                {(r.status === "failed" || r.status === "unclaimed" || r.status === "emailed") && (
                  <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => void act(r, true)}>
                    Give another certificate
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
