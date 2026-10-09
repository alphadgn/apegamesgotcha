import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminPublishPool,
  adminReconcilePublication,
  adminRunSettlement,
  adminSetDrawPause,
  adminVrfStatus,
} from "@/lib/draws.functions";
import { adminAlerts, adminResolveAlert } from "@/lib/seasons.functions";
import { Button } from "@/components/ui/button";
import { Card, KV, QueryError, useAction } from "./common";

/** Chainlink draws: contract health, odds publication, settlement queue, pause, and operational alerts. */
export function SettlementPanel() {
  const status = useServerFn(adminVrfStatus);
  const publish = useServerFn(adminPublishPool);
  const reconcilePub = useServerFn(adminReconcilePublication);
  const settle = useServerFn(adminRunSettlement);
  const pause = useServerFn(adminSetDrawPause);
  const alertsFn = useServerFn(adminAlerts);
  const resolve = useServerFn(adminResolveAlert);
  const qc = useQueryClient();
  const { data, error, isFetching } = useQuery({
    queryKey: ["vrf-status"],
    queryFn: () => status(),
  });
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () => alertsFn({ data: { includeResolved: false } }),
  });
  const { busy, run } = useAction();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["vrf-status"] });
    void qc.invalidateQueries({ queryKey: ["alerts"] });
  };
  const coord = data?.coordination as
    | {
        requests_paused?: boolean;
        pause_reason?: string | null;
        pool_publishing?: boolean;
        worker_last_run_at?: string | null;
        active_batch_id?: string | null;
      }
    | null
    | undefined;
  const health = (data && "health" in data ? data.health : null) as Record<
    string,
    string | boolean
  > | null;

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card
        title="Draw contract"
        actions={
          <Button size="sm" variant="outline" disabled={isFetching} onClick={refresh}>
            Refresh
          </Button>
        }
      >
        <QueryError error={error} />
        {data && (
          <div>
            <KV k="Real draws enabled" v={data.enabled ? "yes" : "no"} warn={!data.enabled} />
            <KV
              k="Contract"
              v={
                data.configured ? (
                  data.contractUrl ? (
                    <a
                      className="underline"
                      href={data.contractUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {String(data.contract).slice(0, 12)}…
                    </a>
                  ) : (
                    String(data.contract)
                  )
                ) : (
                  "not set"
                )
              }
              warn={!data.configured}
            />
            {data.configured && (
              <>
                <KV
                  k="Odds in sync"
                  v={data.oddsInSync ? "yes" : "no — publish"}
                  warn={!data.oddsInSync}
                />
                <KV k="Pool version" v={String(data.poolVersion)} />
                <KV k="Pending on-chain" v={String(data.pendingOnChain)} />
                <KV
                  k="Paused on-chain"
                  v={data.chainPaused ? "yes" : "no"}
                  warn={!!data.chainPaused}
                />
                {health && "error" in health ? (
                  <KV k="VRF health" v={String(health["error"])} warn />
                ) : health ? (
                  <>
                    <KV k="Coordinator" v={String(health["coordinator"]).slice(0, 12) + "…"} />
                    <KV
                      k="Subscription"
                      v={`${health["subscriptionId"]} · ${health["nativePayment"] ? "native" : "LINK"} balance ${health["nativePayment"] ? health["nativeBalance"] : health["balance"]}`}
                    />
                    <KV
                      k="Registered consumer"
                      v={health["isConsumer"] ? "yes" : "no"}
                      warn={!health["isConsumer"]}
                    />
                  </>
                ) : null}
              </>
            )}
            <KV k="Pending spins (app)" v={String(data.pendingDb)} />
            <KV
              k="Draw in flight"
              v={coord?.active_batch_id ? String(coord.active_batch_id).slice(0, 8) : "none"}
            />
            <KV
              k="Worker last run"
              v={
                coord?.worker_last_run_at
                  ? new Date(coord.worker_last_run_at).toISOString()
                  : "never"
              }
              warn={
                !coord?.worker_last_run_at ||
                Date.now() - Date.parse(coord.worker_last_run_at) > 10 * 60_000
              }
            />
            <KV
              k="Requests paused (app)"
              v={coord?.requests_paused ? `yes — ${coord.pause_reason ?? ""}` : "no"}
              warn={!!coord?.requests_paused}
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() =>
              run(
                "settle",
                () =>
                  settle().then((r) => {
                    refresh();
                    return r;
                  }),
                () => "Settlement pass finished",
              )
            }
          >
            {busy === "settle" ? "Running…" : "Run settlement now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              run(
                "pause",
                () =>
                  pause({
                    data: { paused: !coord?.requests_paused, reason: "Paused by admin" },
                  }).then(refresh),
                () => (coord?.requests_paused ? "Resumed" : "Paused"),
              )
            }
          >
            {coord?.requests_paused ? "Resume draws" : "Pause new draws"}
          </Button>
        </div>
      </Card>

      <Card title="Publish odds on-chain">
        <p className="text-sm text-muted-foreground">
          Locks out new draws, requires every draw to be reconciled and settled, reconciles stock
          with the chain (never raising it above chain stock except by audited restocks), then sends
          setPool. If the transaction doesn't confirm, draws stay locked until you reconcile it.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            disabled={!!busy}
            onClick={() =>
              run(
                "publish",
                () =>
                  publish().then((r) => {
                    refresh();
                    return r;
                  }),
                (r) => `Published v${(r as { version: string }).version}`,
              )
            }
          >
            {busy === "publish" ? "Publishing…" : "Publish prize pool"}
          </Button>
          {coord?.pool_publishing && (
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                run(
                  "rec",
                  () =>
                    reconcilePub().then((r) => {
                      refresh();
                      return r;
                    }),
                  (r) =>
                    (r as { ok: boolean }).ok
                      ? "Publication confirmed"
                      : "Not on-chain; publish again",
                )
              }
            >
              Reconcile publication
            </Button>
          )}
        </div>
        {data && "openBatches" in data && (data.openBatches as unknown[]).length > 0 && (
          <div className="mt-4">
            <h4 className="text-sm font-bold">Settlement queue</h4>
            {(
              data.openBatches as {
                id: string;
                status: string;
                created_at: string;
                spin_count: number;
                request_tx: string | null;
                last_error: string | null;
              }[]
            ).map((b) => (
              <p key={b.id} className="font-mono text-xs">
                {b.id.slice(0, 8)} · {b.status} · {b.spin_count} spin(s) ·{" "}
                {b.created_at.slice(11, 19)}Z{b.last_error ? ` · ${b.last_error}` : ""}
              </p>
            ))}
          </div>
        )}
      </Card>

      <div className="lg:col-span-2">
        <Card title={`Alerts (${alerts.data?.length ?? 0} open)`}>
          <QueryError error={alerts.error} />
          {(alerts.data ?? []).map((a) => (
            <div
              key={String(a["id"])}
              className="flex flex-wrap items-start justify-between gap-2 border-b border-border py-2 text-sm"
            >
              <div>
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${a["severity"] === "critical" ? "bg-destructive text-destructive-foreground" : "bg-muted"}`}
                >
                  {String(a["severity"])}
                </span>
                <b>{String(a["kind"])}</b> {String(a["subject"] ?? "")}
                <p className="text-xs text-muted-foreground">
                  {String(a["message"])} · seen {String(a["occurrences"])}× · last{" "}
                  {String(a["last_seen"]).slice(0, 19)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  run(
                    "res",
                    () =>
                      resolve({
                        data: { kind: String(a["kind"]), subject: String(a["subject"] ?? "") },
                      }).then(refresh),
                    () => "Resolved",
                  )
                }
              >
                Resolve
              </Button>
            </div>
          ))}
          {!alerts.data?.length && <p className="text-sm text-muted-foreground">No open alerts.</p>}
        </Card>
      </div>
    </div>
  );
}
