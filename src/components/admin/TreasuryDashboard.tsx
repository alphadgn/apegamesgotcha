// Admin → Treasury: Dashboard (phase 2), Keeper (phase 3: jobs, runs, alerts) and Settings. Super admin only.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatEther } from "viem";
import {
  adminAckAlerts,
  adminCloseJob,
  adminRetryJob,
  adminRunKeeper,
  adminSaveTreasurySettings,
  adminTreasuryAction,
  adminTreasuryEvents,
  adminTreasuryOverview,
} from "@/lib/treasury.functions";
import {
  BUCKET_JOBS,
  DEFAULT_TREASURY_SETTINGS,
  type TreasurySettings,
} from "@/lib/treasury-settings";
import { BUCKETS, SPLITTER_CHAINS, type SplitterChainId } from "@/contracts/splitter";
import { confirmAction } from "@/components/ConfirmAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const ape = (w?: string | null, dp = 4) =>
  w == null
    ? "—"
    : Number(formatEther(BigInt(w))).toLocaleString(undefined, { maximumFractionDigits: dp });
export const TREASURY_KEY = ["treasury-overview"] as const;

export function useTreasury() {
  const fn = useServerFn(adminTreasuryOverview);
  return useQuery({ queryKey: TREASURY_KEY, queryFn: () => fn(), refetchInterval: 30_000 });
}
type Overview = NonNullable<ReturnType<typeof useTreasury>["data"]>;

const STATUS_TONE: Record<string, string> = {
  delivered: "bg-primary/20 text-primary",
  failed: "bg-destructive/20 text-destructive",
};

// ---------------------------------------------------------------- Dashboard

export function TreasuryDashboard() {
  const { data, error, isFetching, refetch } = useTreasury();
  const act = useServerFn(adminTreasuryAction);
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <p className="mt-4 text-destructive">{(error as Error).message}</p>;
  if (!data) return <p className="mt-4 text-muted-foreground">Loading the treasury…</p>;
  const meta = SPLITTER_CHAINS[data.settings.splitter_chain_id as SplitterChainId];
  const explorer = meta.explorer;

  const run = async (action: "payoutAll" | "syncSurplus" | "release", bucket?: number) => {
    const b = bucket != null ? data.chain?.buckets[bucket] : null;
    const titles = {
      payoutAll: "Pay out Team + Operations now?",
      syncSurplus: "Split any APE that reached the contract without being split?",
      release: `Release bucket ${bucket} (${b?.name ?? ""}) now?`,
    };
    const ok = await confirmAction({
      title: titles[action],
      description: `Sent from the keeper wallet on ${meta.name}. This is a real transaction even with dry run on.${action === "release" ? " The APE goes to the bucket's buyer wallet and the keeper bot continues the purchase from there." : ""}`,
      confirmLabel: action === "release" ? "Release" : "Send",
      destructive: !meta.testnet,
    });
    if (!ok) return;
    setBusy(action + (bucket ?? ""));
    try {
      const r = await act({ data: { action, ...(bucket != null ? { bucket } : {}) } });
      toast.success(`Sent${r.tx ? ` (${short(r.tx)})` : ""}`);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 space-y-6 text-left">
      <AlertsCard data={data} onChanged={() => void refetch()} />
      <section className="rounded border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold">Splitter on {meta.name}</h3>
            {data.splitter ? (
              <a
                className="font-mono text-sm underline"
                href={`${explorer}/address/${data.splitter.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {data.splitter.address}
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active splitter on this network. Deploy one and tap “Make active” (Deploy tab).
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {data.settings.dry_run && (
              <span className="rounded bg-amber-400/20 px-2 py-0.5 text-xs font-bold text-amber-300">
                DRY RUN
              </span>
            )}
            {data.settings.kill_switch && (
              <span className="rounded bg-destructive/20 px-2 py-0.5 text-xs font-bold text-destructive">
                KILL SWITCH ON
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>
        {data.chainError && <p className="mt-2 text-sm text-destructive">{data.chainError}</p>}
        {data.chain && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat
                label="Lifetime fees received"
                value={`${ape(data.chain.totalReceived, 2)} APE`}
              />
              <Stat label="Held in buckets" value={`${ape(data.chain.totalTracked, 2)} APE`} />
              <Stat label="Contract balance" value={`${ape(data.chain.balance, 2)} APE`} />
              <Stat
                label="Keeper"
                value={short(data.chain.keeper)}
                tone={
                  data.keeperAddress &&
                  data.keeperAddress !== data.chain.keeper &&
                  data.keeperAddress !== data.chain.owner
                    ? "text-destructive"
                    : undefined
                }
              />
            </div>
            {data.keeperAddress &&
              data.keeperAddress !== data.chain.keeper &&
              data.keeperAddress !== data.chain.owner && (
                <p className="mt-2 text-sm text-destructive">
                  The KEEPER_PRIVATE_KEY wallet ({short(data.keeperAddress)}) is not this splitter's
                  keeper or owner, so the bot can't act. Set it with setKeeper from the owner
                  wallet, or use the matching key.
                </p>
              )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" disabled={!!busy} onClick={() => void run("payoutAll")}>
                Pay out Team + Ops
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => void run("syncSurplus")}
              >
                Sync surplus
              </Button>
            </div>
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {data.chain.buckets.map((b, i) => {
                const accrue = b.mode === 1;
                const bal = BigInt(b.balance);
                const tgt = BigInt(b.target);
                const pctFill =
                  accrue && tgt > 0n ? Math.min(100, Number((bal * 10000n) / tgt) / 100) : null;
                const enabled = i >= 2 ? data.settings.buckets[String(i)]?.enabled : true;
                return (
                  <li key={i} className="rounded border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 font-bold">
                        {i}. {b.name}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          {b.bps / 100}% · {accrue ? "Accrue" : "Direct"}
                        </span>
                      </p>
                      {accrue &&
                        (b.ready ? (
                          <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-bold text-primary">
                            Ready to buy
                          </span>
                        ) : null)}
                      {i >= 2 && !enabled && (
                        <span className="rounded bg-muted px-2 py-0.5 text-xs">Disabled</span>
                      )}
                    </div>
                    <p className="mt-1">
                      Balance <b>{ape(b.balance)} APE</b>
                      {accrue && (
                        <>
                          {" "}
                          · target {tgt === 0n ? "none (whole balance)" : `${ape(b.target)} APE`}
                        </>
                      )}
                    </p>
                    {pctFill != null && (
                      <div
                        className="mt-2 h-2 w-full overflow-hidden rounded bg-muted"
                        aria-label={`${pctFill.toFixed(1)}% of target`}
                      >
                        <div className="h-full bg-primary" style={{ width: `${pctFill}%` }} />
                      </div>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Recipient <span className="font-mono">{short(b.recipient)}</span>
                      {i >= 2 && ` · ${BUCKET_JOBS[i]!.label}`}
                    </p>
                    {accrue && (
                      <Button
                        className="mt-2"
                        size="sm"
                        variant="outline"
                        disabled={!!busy || !b.ready}
                        onClick={() => void run("release", i)}
                      >
                        Release
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      <KeeperWalletCard data={data} />
      <EventsCard explorer={explorer} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <div className="rounded border border-border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-bold ${tone ?? ""}`}>{value}</p>
    </div>
  );
}

function KeeperWalletCard({ data }: { data: Overview }) {
  const missing = Object.entries(data.secrets).filter(
    ([k, v]) => !v && ["KEEPER_PRIVATE_KEY", "OPENSEA_API_KEY"].includes(k),
  );
  return (
    <section className="rounded border bg-card p-4 text-sm">
      <h3 className="text-lg font-bold">Keeper / buyer wallet</h3>
      {data.keeperAddress ? (
        <p className="mt-1 break-all font-mono">{data.keeperAddress}</p>
      ) : (
        <p className="mt-1 text-destructive">KEEPER_PRIVATE_KEY isn't set (Lovable → Secrets).</p>
      )}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat
          label="APE on ApeChain (gas + bridging)"
          value={data.balances.ape == null ? "—" : `${ape(data.balances.ape)} APE`}
        />
        <Stat
          label="ETH on Ethereum"
          value={data.balances.ethereum == null ? "—" : `${ape(data.balances.ethereum, 5)} ETH`}
        />
        <Stat
          label="ETH on Robinhood Chain"
          value={
            data.balances.robinhood == null
              ? "— (set the RPC)"
              : `${ape(data.balances.robinhood, 5)} ETH`
          }
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Secrets:{" "}
        {Object.entries(data.secrets).map(([k, v]) => (
          <span key={k} className={`mr-2 ${v ? "text-primary" : ""}`}>
            {k} {v ? "✓" : "—"}
          </span>
        ))}
      </p>
      {missing.length > 0 && (
        <p className="mt-1 text-xs text-destructive">
          Needed for buying: {missing.map(([k]) => k).join(", ")}.
        </p>
      )}
    </section>
  );
}

function AlertsCard({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const ack = useServerFn(adminAckAlerts);
  if (!data.alerts.length) return null;
  return (
    <section className="rounded border border-destructive bg-destructive/10 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">Alerts ({data.alerts.length})</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void ack({ data: {} }).then(
              () => onChanged(),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          Dismiss all
        </Button>
      </div>
      <ul className="mt-2 space-y-1">
        {data.alerts.slice(0, 10).map((a) => (
          <li
            key={a.id}
            className={
              a.level === "info"
                ? "text-primary"
                : a.level === "warn"
                  ? "text-amber-300"
                  : "text-destructive"
            }
          >
            <span className="text-xs text-muted-foreground">
              {new Date(a.created_at).toLocaleString()} ·{" "}
            </span>
            {a.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventsCard({ explorer }: { explorer: string }) {
  const fn = useServerFn(adminTreasuryEvents);
  const [open, setOpen] = useState(false);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["treasury-events"],
    queryFn: () => fn(),
    enabled: open,
  });
  return (
    <section className="rounded border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">History</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={isFetching}
          onClick={() => (open ? void refetch() : setOpen(true))}
        >
          {isFetching ? "Reading the chain…" : open ? "Refresh" : "Show history"}
        </Button>
      </div>
      {error && <p className="mt-2 text-destructive">{(error as Error).message}</p>}
      {data?.behind && (
        <p className="mt-2 text-xs text-muted-foreground">
          Still catching up with older blocks — tap Refresh to read more.
        </p>
      )}
      {data && !data.rows.length && <p className="mt-2 text-muted-foreground">No events yet.</p>}
      {data && data.rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Block</th>
                <th className="py-1 pr-2">Event</th>
                <th className="py-1 pr-2">Bucket</th>
                <th className="py-1 pr-2">Amount (APE)</th>
                <th className="py-1 pr-2">Address</th>
                <th className="py-1">Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1 pr-2">{r.block_number}</td>
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="py-1 pr-2">
                    {r.bucket != null ? `${r.bucket}. ${BUCKETS[r.bucket]?.name ?? ""}` : "—"}
                  </td>
                  <td className="py-1 pr-2">
                    {r.name === "TargetSet" ? `target ${ape(r.target_wei)}` : ape(r.amount_wei)}
                  </td>
                  <td className="py-1 pr-2 font-mono">{short(r.address)}</td>
                  <td className="py-1">
                    <a
                      className="underline"
                      href={`${explorer}/tx/${r.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(r.tx_hash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Keeper

export function TreasuryKeeper() {
  const { data, refetch } = useTreasury();
  const runFn = useServerFn(adminRunKeeper);
  const retry = useServerFn(adminRetryJob);
  const close = useServerFn(adminCloseJob);
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  if (!data) return <p className="mt-4 text-muted-foreground">Loading…</p>;
  const runNow = async () => {
    if (
      !(await confirmAction({
        title: "Run the keeper now?",
        description: data.settings.dry_run
          ? "Dry run is ON: it only logs what it would do."
          : "Dry run is OFF: it may send real transactions (payouts, targets, releases, bridges and buys).",
        confirmLabel: "Run now",
        destructive: !data.settings.dry_run,
      }))
    )
      return;
    setBusy(true);
    try {
      const r = await runFn();
      if (!r.ran) toast.info(r.reason ?? "Didn't run.");
      else toast.success("Keeper run finished");
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const doRetry = async (id: string) => {
    if (
      !(await confirmAction({
        title: "Retry this job from its last good step?",
        description: "The keeper continues it on its next run (or press Run now).",
        confirmLabel: "Retry",
      }))
    )
      return;
    try {
      const r = await retry({ data: { id } });
      toast.success(`Will continue from "${r.status}"`);
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const doClose = async (id: string) => {
    if (
      !(await confirmAction({
        title: "Close this failed job?",
        description:
          "Only after you've dealt with its funds by hand (APE, ETH, tokens or an NFT may be in the keeper wallet). The bucket can then start a new buy.",
        confirmLabel: "Close job",
        destructive: true,
      }))
    )
      return;
    try {
      await close({ data: { id } });
      toast.success("Job closed");
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const destExplorer = (job: Overview["jobs"][number], tx: string | null) => {
    if (!tx) return null;
    const ape = SPLITTER_CHAINS[job.chain_id as SplitterChainId]?.explorer;
    return job.bucket === 6 || job.bucket === 7
      ? `https://etherscan.io/tx/${tx}`
      : `${ape}/tx/${tx}`;
  };
  return (
    <div className="mt-4 space-y-6 text-left text-sm">
      <section className="rounded border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold">Keeper bot</h3>
            <p className="text-muted-foreground">
              Runs every 10 minutes. Last run:{" "}
              {data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "never"}.{" "}
              {data.settings.dry_run ? "Dry run ON (logs only)." : "LIVE: sends transactions."}
              {data.settings.kill_switch ? " Kill switch ON." : ""}
            </p>
          </div>
          <Button disabled={busy} onClick={() => void runNow()}>
            {busy ? "Running…" : "Run keeper now"}
          </Button>
        </div>
      </section>

      <section className="rounded border bg-card p-4">
        <h3 className="text-lg font-bold">Buy jobs</h3>
        {!data.jobs.length && <p className="mt-2 text-muted-foreground">No jobs yet.</p>}
        <ul className="mt-2 space-y-2">
          {data.jobs.map((j) => (
            <li key={j.id} className="rounded border border-border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1">
                  <b>
                    Bucket {j.bucket}. {BUCKETS[j.bucket]?.name}
                  </b>{" "}
                  <span className="text-xs text-muted-foreground">
                    {new Date(j.created_at).toLocaleString()}
                  </span>
                </p>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_TONE[j.status] ?? "bg-amber-400/20 text-amber-300"}`}
                >
                  {j.status}
                </span>
                {j.status === "failed" && j.last_ok_status && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void doRetry(j.id)}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void doClose(j.id)}>
                      Close
                    </Button>
                  </>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {j.released_ape_wei && `Released ${ape(j.released_ape_wei)} APE. `}
                {j.bridge_expected_wei && `Bridge expected ${ape(j.bridge_expected_wei, 5)}. `}
                {j.token_id && `Token #${j.token_id} for ${ape(j.price_wei, 5)} ETH. `}
                {j.note}
              </p>
              <p className="text-xs">
                {[
                  [
                    "release",
                    SPLITTER_CHAINS[j.chain_id as SplitterChainId]?.explorer
                      ? `${SPLITTER_CHAINS[j.chain_id as SplitterChainId].explorer}/tx/${j.release_tx}`
                      : null,
                    j.release_tx,
                  ],
                  [
                    "bridge",
                    j.bridge_tx
                      ? `${SPLITTER_CHAINS[j.chain_id as SplitterChainId]?.explorer}/tx/${j.bridge_tx}`
                      : null,
                    j.bridge_tx,
                  ],
                  [
                    "relay",
                    j.relay_request_id
                      ? `https://relay.link/transaction/${j.relay_request_id}`
                      : null,
                    j.relay_request_id,
                  ],
                  ["buy", destExplorer(j, j.buy_tx), j.buy_tx],
                  ["deliver", destExplorer(j, j.deliver_tx), j.deliver_tx],
                ]
                  .filter(([, , v]) => v)
                  .map(([label, href]) => (
                    <a
                      key={label}
                      className="mr-3 underline"
                      href={href!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {label} ↗
                    </a>
                  ))}
              </p>
              {j.error && <p className="text-xs text-destructive">{j.error}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border bg-card p-4">
        <h3 className="text-lg font-bold">Recent runs</h3>
        {!data.runs.length && <p className="mt-2 text-muted-foreground">No runs yet.</p>}
        <ul className="mt-2 space-y-1">
          {data.runs.map((r) => (
            <li key={r.id} className="rounded border border-border p-2">
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-2 text-left"
                onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
              >
                <span className="flex-1">
                  {new Date(r.started_at).toLocaleString()} · {r.trigger}
                  {r.dry_run ? " · dry run" : ""}
                </span>
                <span
                  className={
                    r.ok === false
                      ? "text-destructive"
                      : r.ok
                        ? "text-primary"
                        : "text-muted-foreground"
                  }
                >
                  {r.ok === false ? "failed" : r.ok ? "ok" : "running"}
                </span>
              </button>
              {openRun === r.id && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {r.log.map((l, i) => (
                    <li key={i}>
                      <span className="text-muted-foreground">
                        {new Date(l.at).toLocaleTimeString()}{" "}
                      </span>
                      {l.msg}
                      {l.data?.["tx"] && (
                        <span className="font-mono"> ({short(l.data["tx"])})</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Settings

export function TreasurySettingsForm() {
  const { data, refetch } = useTreasury();
  const save = useServerFn(adminSaveTreasurySettings);
  const [f, setF] = useState<TreasurySettings>(DEFAULT_TREASURY_SETTINGS);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.settings) setF(data.settings);
  }, [data?.settings]);
  if (!data) return <p className="mt-4 text-muted-foreground">Loading…</p>;
  const saved = data.settings;
  const txt = (k: keyof TreasurySettings, label: string, placeholder = "", hint?: string) => (
    <label className="block text-sm">
      {label}
      <Input
        className="mt-1 font-mono"
        placeholder={placeholder}
        value={String(f[k] ?? "")}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
  const num = (
    k: "buffer_pct" | "slippage_pct" | "target_move_pct" | "robinhood_chain_id",
    label: string,
    hint?: string,
  ) => (
    <label className="block text-sm">
      {label}
      <Input
        className="mt-1"
        inputMode="decimal"
        value={String(f[k])}
        onChange={(e) => setF({ ...f, [k]: Number(e.target.value) || 0 })}
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
  const submit = async () => {
    const goingLive = saved.dry_run && !f.dry_run;
    const feesOn = !saved.fees_to_splitter && f.fees_to_splitter;
    const ok = await confirmAction({
      title: goingLive
        ? "Turn dry run OFF and let the bot spend for real?"
        : "Save treasury settings?",
      description:
        [
          goingLive
            ? "The keeper will send real transactions: payouts, targets, releases, bridges and NFT buys, within the max spend per bucket."
            : "",
          feesOn
            ? "Gotcha spin payments will go to the ApeChain mainnet splitter (deposit()) instead of the treasury wallet."
            : "",
          f.kill_switch && !saved.kill_switch
            ? "The kill switch stops the keeper and all manual treasury transactions."
            : "",
        ]
          .filter(Boolean)
          .join(" ") || "The keeper uses these on its next run.",
      confirmLabel: goingLive ? "Go live" : "Save",
      destructive: goingLive || feesOn,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await save({ data: f as never });
      toast.success("Settings saved");
      await refetch();
    } catch (e) {
      const m = (e as Error).message;
      toast.error(m.trim().startsWith("[") ? `Check the fields: ${m.slice(0, 200)}` : m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-6 text-left text-sm">
      <section className="rounded border bg-card p-4">
        <h3 className="text-lg font-bold">Safety</h3>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.dry_run}
              onChange={(e) => setF({ ...f, dry_run: e.target.checked })}
            />
            <b>Dry run</b> — log what would happen, send no transactions (recommended until tested)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.kill_switch}
              onChange={(e) => setF({ ...f, kill_switch: e.target.checked })}
            />
            <b className="text-destructive">Kill switch</b> — stop the keeper and all treasury
            transactions
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.fees_to_splitter}
              onChange={(e) => setF({ ...f, fees_to_splitter: e.target.checked })}
            />
            <b>Send Gotcha spin payments to the ApeChain mainnet splitter</b> (instead of the
            treasury wallet)
          </label>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            Network the keeper works on
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3"
              value={f.splitter_chain_id}
              onChange={(e) =>
                setF({ ...f, splitter_chain_id: Number(e.target.value) as 33139 | 33111 })
              }
            >
              <option value={33111}>Curtis testnet</option>
              <option value={33139}>ApeChain mainnet</option>
            </select>
          </label>
          {num("buffer_pct", "Buffer % on targets", "Default 5")}
          {num("slippage_pct", "Max slippage %", "Abort a bridge this much worse than planned")}
          {num("target_move_pct", "Re-post target when it moves >", "Percent; default 2")}
          {txt("ape_gas_reserve", "APE kept for ApeChain gas", "1")}
          <label className="block">
            ETH kept for gas — Ethereum / Robinhood
            <div className="mt-1 grid grid-cols-2 gap-1">
              <Input
                value={f.gas_allowance_eth.ethereum}
                onChange={(e) =>
                  setF({
                    ...f,
                    gas_allowance_eth: { ...f.gas_allowance_eth, ethereum: e.target.value },
                  })
                }
              />
              <Input
                value={f.gas_allowance_eth.robinhood}
                onChange={(e) =>
                  setF({
                    ...f,
                    gas_allowance_eth: { ...f.gas_allowance_eth, robinhood: e.target.value },
                  })
                }
              />
            </div>
          </label>
        </div>
      </section>

      <section className="rounded border bg-card p-4">
        <h3 className="text-lg font-bold">Buckets</h3>
        <ul className="mt-2 space-y-2">
          {[2, 3, 4, 5, 6, 7].map((i) => {
            const b = f.buckets[String(i)]!;
            const setB = (patch: Partial<typeof b>) =>
              setF({ ...f, buckets: { ...f.buckets, [String(i)]: { ...b, ...patch } } });
            return (
              <li
                key={i}
                className="flex flex-wrap items-center gap-3 rounded border border-border p-2"
              >
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={(e) => setB({ enabled: e.target.checked })}
                  />
                  <span>
                    <b>
                      {i}. {BUCKETS[i]!.name}
                    </b>
                    <span className="block text-xs text-muted-foreground">
                      {BUCKET_JOBS[i]!.label}
                    </span>
                  </span>
                </label>
                {BUCKET_JOBS[i]!.kind === "nft" && (
                  <label className="text-xs">
                    Max spend per buy (ETH)
                    <Input
                      className="mt-1 w-28"
                      value={b.max_spend_eth}
                      onChange={(e) => setB({ max_spend_eth: e.target.value })}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded border bg-card p-4">
        <h3 className="text-lg font-bold">Destinations & markets</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {txt("prize_wallet_ethereum", "Prize wallet on Ethereum (BAYC / MAYC go here)", "0x…")}
          {txt(
            "prize_wallet_robinhood",
            "Prize wallet on Robinhood Chain (StonkBroker NFT)",
            "0x…",
          )}
          {txt("bayc_slug", "BAYC OpenSea slug", "boredapeyachtclub")}
          {txt("mayc_slug", "MAYC OpenSea slug", "mutant-ape-yacht-club")}
          {txt(
            "stonk_nft_slug",
            "StonkBroker NFT OpenSea slug",
            "",
            "From the collection's OpenSea URL",
          )}
          {txt(
            "stonk_nft_contract",
            "StonkBroker NFT contract",
            "0x…",
            "Buys are refused if the listing isn't this contract",
          )}
          {txt("stonk_token", "$STONKBROKER token (Robinhood Chain)", "0x…")}
          {num("robinhood_chain_id", "Robinhood Chain ID", "Listed as 4663 — confirm")}
          {txt(
            "robinhood_rpc_url",
            "Robinhood Chain RPC (https)",
            "https://…",
            "Or the ROBINHOOD_RPC_URL secret",
          )}
          {txt("robinhood_opensea_chain", "OpenSea chain name for Robinhood", "robinhood")}
          {txt(
            "eth_rpc_url",
            "Ethereum RPC (optional)",
            "https://…",
            "Or the ETH_RPC_URL secret; public RPCs otherwise",
          )}
          {txt(
            "telegram_chat_id",
            "Telegram chat ID for alerts (optional)",
            "",
            "Bot token = TELEGRAM_BOT_TOKEN secret",
          )}
        </div>
      </section>

      <Button disabled={busy} onClick={() => void submit()}>
        {busy ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}
