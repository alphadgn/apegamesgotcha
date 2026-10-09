// Admin panels for the season leaderboard: seasons/rules, snapshots, share review, ledger reversals,
// economics, and operations (alerts + settlement queue). Every action goes through audited server functions.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  adminListSeasons,
  adminCreateSeasonDraft,
  adminUpdateSeasonDraft,
  adminSetSeasonCollections,
  adminActivateSeason,
  adminFinalizeSeason,
  adminSupersedeStandings,
  adminBackfillReport,
  adminExportStandingsCsv,
  adminListCollections,
  adminUpsertCollection,
  adminIndexCollection,
  adminVerifyCollection,
  adminShareQueue,
  adminReviewShare,
  adminLedgerLookup,
  adminReversePoints,
  adminEconomics,
  adminRecordCost,
  adminSavePrizeEconomics,
  adminRecordReserve,
  adminSaveBudget,
  adminOps,
  adminResolveAlert,
  adminResolveConflict,
} from "@/lib/season.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const DEFAULT_RULES = {
  nft_snapshot_points: 100,
  participation_points: 10,
  rarity_bonus: { common: 25, rare: 100, epic: 250, legendary: 500 },
  prize_bonus_overrides: {},
  social_share_points: 2,
  social_daily_limit: 1,
  social_enabled: false,
  referrals_enabled: false,
  daily_spin_limit: 10,
  season_spin_limit: 100,
  historical_backfill_enabled: false,
};

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded border border-border bg-card p-4 text-left">
      <h3 className="font-bold">{title}</h3>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

const toIso = (local: string) => (local ? new Date(`${local}Z`).toISOString() : null);
const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");

// ---------------------------------------------------------------- Seasons
type SeasonRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_legacy: boolean;
  starts_at: string | null;
  ends_at: string | null;
  settlement_deadline: string | null;
  rules: Record<string, unknown>;
  rules_hash: string | null;
  notes: string | null;
  collections: string[];
  unresolved: { kind: string; item_count: string }[];
};

export function SeasonsPanel() {
  const list = useServerFn(adminListSeasons);
  const cols = useServerFn(adminListCollections);
  const { data, error, refetch } = useQuery({ queryKey: ["admin-seasons"], queryFn: () => list() });
  const { data: collections } = useQuery({
    queryKey: ["admin-collections"],
    queryFn: () => cols(),
  });
  const [editing, setEditing] = useState<SeasonRow | "new" | null>(null);
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Seasons start as drafts. Activation freezes the rules and snapshot configuration and is
        never automatic. Dates are UTC; the end is exclusive.
      </p>
      {error && (
        <p className="text-sm text-destructive">
          {(error as Error).message}{" "}
          <button className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      <Button size="sm" onClick={() => setEditing("new")}>
        New draft season
      </Button>
      {editing && (
        <SeasonEditor
          season={editing === "new" ? null : editing}
          collections={
            (collections ?? []) as { id: string; name: string; status: string; edition: string }[]
          }
          onClose={() => setEditing(null)}
        />
      )}
      {((data ?? []) as SeasonRow[]).map((s) => (
        <SeasonCard key={s.id} s={s} onEdit={() => setEditing(s)} />
      ))}
    </div>
  );
}

function SeasonCard({ s, onEdit }: { s: SeasonRow; onEdit: () => void }) {
  const activate = useServerFn(adminActivateSeason);
  const finalize = useServerFn(adminFinalizeSeason);
  const supersede = useServerFn(adminSupersedeStandings);
  const backfill = useServerFn(adminBackfillReport);
  const exportCsv = useServerFn(adminExportStandingsCsv);
  const { busy, run } = useAction();
  const [report, setReport] = useState<string | null>(null);
  return (
    <Card title={`${s.name} · ${s.slug} · ${s.status}${s.is_legacy ? " (archive)" : ""}`}>
      {!s.is_legacy && (
        <p className="font-mono text-xs">
          {s.starts_at ?? "no start"} → {s.ends_at ?? "no end"} (exclusive) · settlement by{" "}
          {s.settlement_deadline ?? "—"}
          {s.rules_hash && (
            <>
              <br />
              rules hash {s.rules_hash}
            </>
          )}
        </p>
      )}
      {s.unresolved.length > 0 && (
        <p className="text-destructive">
          Unresolved: {s.unresolved.map((u) => `${u.kind} ${u.item_count}`).join(", ")}
        </p>
      )}
      <details>
        <summary className="cursor-pointer">Rules</summary>
        <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(s.rules, null, 2)}</pre>
      </details>
      <div className="flex flex-wrap gap-2">
        {s.status === "draft" && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit draft
          </Button>
        )}
        {s.status === "draft" && (
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => {
              const typed = window.prompt(
                `Activating freezes this season's rules and snapshot collections. Type the slug "${s.slug}" to activate.`,
              );
              if (typed)
                void run(
                  "activate",
                  () => activate({ data: { seasonId: s.id, confirmSlug: typed } }),
                  "Season activated",
                );
            }}
          >
            Activate…
          </Button>
        )}
        {(s.status === "active" || s.status === "settling") && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() =>
              void run("finalize", () => finalize({ data: { seasonId: s.id } }), "Season finalized")
            }
          >
            Finalize (after cutoff)
          </Button>
        )}
        {s.status === "finalized" && !s.is_legacy && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => {
              const reason = window.prompt("Reason for the corrected standings (audited):");
              if (reason)
                void run(
                  "supersede",
                  () => supersede({ data: { seasonId: s.id, reason } }),
                  "Superseding standings published",
                );
            }}
          >
            Publish correction…
          </Button>
        )}
        {!s.is_legacy && s.status !== "draft" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              void run("backfill", async () =>
                setReport(JSON.stringify(await backfill({ data: { seasonId: s.id } }), null, 2)),
              )
            }
          >
            Backfill dry run
          </Button>
        )}
        {s.status !== "draft" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              void run("csv", async () => {
                const r = await exportCsv({ data: { seasonId: s.id } });
                const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = `standings-${s.slug}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              })
            }
          >
            Export CSV
          </Button>
        )}
      </div>
      {report && <pre className="overflow-x-auto font-mono text-xs">{report}</pre>}
    </Card>
  );
}

function SeasonEditor({
  season,
  collections,
  onClose,
}: {
  season: SeasonRow | null;
  collections: { id: string; name: string; status: string; edition: string }[];
  onClose: () => void;
}) {
  const create = useServerFn(adminCreateSeasonDraft);
  const update = useServerFn(adminUpdateSeasonDraft);
  const setCols = useServerFn(adminSetSeasonCollections);
  const { busy, run } = useAction();
  const [slug, setSlug] = useState(season?.slug ?? "");
  const [name, setName] = useState(season?.name ?? "");
  const [starts, setStarts] = useState(toLocal(season?.starts_at ?? null));
  const [ends, setEnds] = useState(toLocal(season?.ends_at ?? null));
  const [deadline, setDeadline] = useState(toLocal(season?.settlement_deadline ?? null));
  const [rules, setRules] = useState(JSON.stringify(season?.rules ?? DEFAULT_RULES, null, 2));
  const [picked, setPicked] = useState<string[]>(season?.collections ?? []);
  const save = () =>
    run(
      "save",
      async () => {
        const body = {
          name,
          startsAt: toIso(starts),
          endsAt: toIso(ends),
          settlementDeadline: toIso(deadline),
          rules: JSON.parse(rules) as Record<string, unknown>,
          notes: null,
        };
        let id = season?.id;
        if (id) await update({ data: { ...body, id } });
        else id = (await create({ data: { ...body, slug } })).id;
        await setCols({ data: { seasonId: id, collectionIds: picked } });
        onClose();
      },
      "Draft saved",
    );
  return (
    <Card title={season ? `Edit draft ${season.slug}` : "New draft season"}>
      {!season && (
        <Input
          placeholder="slug (e.g. season-1)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
      )}
      <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="block">
        Start (UTC)
        <Input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
      </label>
      <label className="block">
        End, exclusive (UTC)
        <Input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
      </label>
      <label className="block">
        Settlement deadline (UTC)
        <Input
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      <label className="block">
        Rules (JSON; frozen at activation)
        <Textarea
          className="h-64 font-mono text-xs"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>Snapshot collections</legend>
        {collections.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={picked.includes(c.id)}
              onChange={(e) =>
                setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))
              }
            />
            {c.name} · {c.edition} · {c.status}
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Snapshots
type CollectionRow = {
  id: string;
  chain_id: number;
  contract: string;
  edition: string;
  name: string;
  status: string;
  snapshot_block: number | null;
  snapshot_block_hash: string | null;
  index_from_block: number;
  index_cursor_block: number | null;
  index_completed_at: string | null;
  index_token_count: number | null;
  verified_at: string | null;
  notes: string | null;
};

export function SnapshotsPanel() {
  const list = useServerFn(adminListCollections);
  const { data, error } = useQuery({ queryKey: ["admin-collections"], queryFn: () => list() });
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Historical recognition uses the owner at the snapshot block (reconstructed from Transfer
        logs, then ownerOf at that block on an archive RPC). Current ownership is never used.
      </p>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {((data ?? []) as CollectionRow[]).map((c) => (
        <CollectionCard key={c.id} c={c} />
      ))}
      <CollectionCard c={null} />
    </div>
  );
}

function CollectionCard({ c }: { c: CollectionRow | null }) {
  const save = useServerFn(adminUpsertCollection);
  const index = useServerFn(adminIndexCollection);
  const verify = useServerFn(adminVerifyCollection);
  const { busy, run } = useAction();
  const [f, setF] = useState({
    chainId: String(c?.chain_id ?? 33139),
    contract: c?.contract ?? "",
    edition: c?.edition ?? "2025",
    name: c?.name ?? "",
    snapshotBlock: c?.snapshot_block != null ? String(c.snapshot_block) : "",
    snapshotBlockHash: c?.snapshot_block_hash ?? "",
    indexFromBlock: String(c?.index_from_block ?? 0),
  });
  const editable = !c || c.status === "candidate";
  return (
    <Card title={c ? `${c.name} · ${c.status}` : "Add collection"}>
      {c?.notes && <p className="text-amber-500">{c.notes}</p>}
      {c && (
        <p className="font-mono text-xs">
          indexed to block {c.index_cursor_block ?? "—"} · {c.index_token_count ?? 0} tokens
          {c.index_completed_at ? " · complete" : ""}
        </p>
      )}
      {editable && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            placeholder="chain id"
            value={f.chainId}
            onChange={(e) => setF({ ...f, chainId: e.target.value })}
          />
          <Input
            placeholder="contract 0x…"
            value={f.contract}
            onChange={(e) => setF({ ...f, contract: e.target.value })}
          />
          <Input
            placeholder="edition"
            value={f.edition}
            onChange={(e) => setF({ ...f, edition: e.target.value })}
          />
          <Input
            placeholder="name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <Input
            placeholder="snapshot block"
            value={f.snapshotBlock}
            onChange={(e) => setF({ ...f, snapshotBlock: e.target.value })}
          />
          <Input
            placeholder="snapshot block hash 0x…"
            value={f.snapshotBlockHash}
            onChange={(e) => setF({ ...f, snapshotBlockHash: e.target.value })}
          />
          <Input
            placeholder="index from block (deploy block)"
            value={f.indexFromBlock}
            onChange={(e) => setF({ ...f, indexFromBlock: e.target.value })}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              void run(
                "save",
                () =>
                  save({
                    data: {
                      ...(c ? { id: c.id } : {}),
                      chainId: Number(f.chainId),
                      contract: f.contract,
                      edition: f.edition,
                      name: f.name,
                      snapshotBlock: f.snapshotBlock ? Number(f.snapshotBlock) : null,
                      snapshotBlockHash: f.snapshotBlockHash || null,
                      indexFromBlock: Number(f.indexFromBlock || 0),
                    },
                  }),
                "Saved",
              )
            }
          >
            Save
          </Button>
        )}
        {c?.status === "candidate" && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              void run("index", async () => {
                const r = await index({ data: { id: c.id } });
                toast.message(
                  r.done
                    ? "Indexing complete"
                    : `Indexed to block ${r.nextBlock - 1}; run again to continue`,
                );
              })
            }
          >
            Index transfers
          </Button>
        )}
        {c?.status === "candidate" && c.index_completed_at && (
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => {
              const evidence = window.prompt(
                "How did you confirm this is the intended 2025 collection, and the snapshot block/hash? (audited)",
              );
              if (evidence)
                void run(
                  "verify",
                  () => verify({ data: { id: c.id, evidence } }),
                  "Collection verified",
                );
            }}
          >
            Mark verified…
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Shares
type ShareRow = {
  id: string;
  post_id: string;
  spin_id: string;
  username: string;
  shareCode: string;
  postUrl: string;
  submitted_at: string;
  award_day: string;
};

export function SharesPanel() {
  const queue = useServerFn(adminShareQueue);
  const { data, error } = useQuery({ queryKey: ["admin-shares"], queryFn: () => queue() });
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Open each post yourself (links open x.com — the server never fetches them). Approve only a
        public post by the linked handle, created during the season and before submission, that
        shows the share code. One rewarded share per player per UTC day is enforced automatically.
      </p>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {!data?.length && !error && (
        <p className="text-sm text-muted-foreground">No shares waiting.</p>
      )}
      {((data ?? []) as ShareRow[]).map((s) => (
        <ShareReview key={s.id} s={s} />
      ))}
    </div>
  );
}

function ShareReview({ s }: { s: ShareRow }) {
  const review = useServerFn(adminReviewShare);
  const { busy, run } = useAction();
  const [author, setAuthor] = useState(s.username);
  const [created, setCreated] = useState("");
  const [refs, setRefs] = useState(false);
  const [pub, setPub] = useState(false);
  return (
    <Card title={`@${s.username} · ${s.shareCode}`}>
      <p>
        <a
          className="text-primary underline"
          href={s.postUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open post {s.post_id}
        </a>{" "}
        · submitted {new Date(s.submitted_at).toISOString()} · award day {s.award_day}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          placeholder="author handle shown on the post"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
        />
        <Input
          type="datetime-local"
          value={created}
          onChange={(e) => setCreated(e.target.value)}
          aria-label="Post created at (UTC)"
        />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={refs} onChange={(e) => setRefs(e.target.checked)} />
        Post shows share code {s.shareCode}
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} />
        Post is public
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!!busy || !created || !refs || !pub}
          onClick={() =>
            void run("approve", async () => {
              const r = await review({
                data: {
                  shareId: s.id,
                  decision: "approve",
                  authorUsername: author,
                  postCreatedAt: new Date(`${created}Z`).toISOString(),
                  referencesSpin: refs,
                  isPublic: pub,
                },
              });
              toast.message(`Result: ${r.status}`);
            })
          }
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => {
            const reason = window.prompt("Reason for rejecting (shown to the player):");
            if (reason)
              void run(
                "reject",
                () => review({ data: { shareId: s.id, decision: "reject", reason } }),
                "Rejected",
              );
          }}
        >
          Reject…
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Ledger reversals
type LedgerRow = {
  id: string;
  amount: string;
  reward_subtype: string;
  source_type: string;
  source_id: string;
  reverses_id: string | null;
  reversal_reason: string | null;
  effective_at: string;
};

export function LedgerPanel() {
  const lookup = useServerFn(adminLedgerLookup);
  const reverse = useServerFn(adminReversePoints);
  const seasons = useServerFn(adminListSeasons);
  const { data: seasonList } = useQuery({ queryKey: ["admin-seasons"], queryFn: () => seasons() });
  const { busy, run } = useAction();
  const [email, setEmail] = useState("");
  const [seasonId, setSeasonId] = useState("");
  const [rows, setRows] = useState<LedgerRow[]>([]);
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        The ledger is append-only. A reversal references the original award, needs a reason, and can
        never exceed what remains.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="player email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          className="h-9 rounded border border-input bg-background px-2 text-sm"
          value={seasonId}
          onChange={(e) => setSeasonId(e.target.value)}
        >
          <option value="">Season…</option>
          {((seasonList ?? []) as SeasonRow[])
            .filter((s) => !s.is_legacy && s.status !== "draft")
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <Button
          size="sm"
          disabled={!email || !seasonId || !!busy}
          onClick={() =>
            void run("lookup", async () =>
              setRows((await lookup({ data: { email, seasonId } })) as LedgerRow[]),
            )
          }
        >
          Look up
        </Button>
      </div>
      <ul className="divide-y divide-border rounded border border-border bg-card font-mono text-xs">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
          >
            <span>
              #{r.id} · {r.reward_subtype} · {r.source_type}:{r.source_id.slice(0, 12)} · {r.amount}
              {r.reverses_id ? ` · reverses #${r.reverses_id} (${r.reversal_reason})` : ""}
            </span>
            {!r.reverses_id && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => {
                  const amount = window.prompt(
                    "Points to reverse (leave empty for everything that remains):",
                    "",
                  );
                  if (amount === null) return;
                  const reason = window.prompt("Reason (audited, at least 5 characters):");
                  if (reason)
                    void run(
                      "reverse",
                      () =>
                        reverse({
                          data: { ledgerId: r.id, amount: amount.trim() || null, reason },
                        }),
                      "Reversed",
                    );
                }}
              >
                Reverse…
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Economics
export function EconomicsPanel() {
  const econ = useServerFn(adminEconomics);
  const recordCost = useServerFn(adminRecordCost);
  const saveReserve = useServerFn(adminRecordReserve);
  const saveBudget = useServerFn(adminSaveBudget);
  const savePrize = useServerFn(adminSavePrizeEconomics);
  const { data, error } = useQuery({ queryKey: ["admin-economics"], queryFn: () => econ() });
  const { busy, run } = useAction();
  const [cost, setCost] = useState({
    category: "gas",
    basis: "per_draw",
    description: "",
    amount: "",
    evidence: "",
  });
  const [reserve, setReserve] = useState({ amount: "", evidence: "" });
  const [budget, setBudget] = useState({
    source: "burn",
    name: "",
    funded: "",
    threshold: "0",
    evidence: "",
  });
  const st = (data?.status ?? {}) as Record<string, unknown>;
  const money = (v: unknown) => (v == null ? "unverified" : `$${Number(v).toFixed(2)}`);
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      <Card title="Status">
        <p>
          Expected cost per spin: {money(st["expected_spin_cost_usd"])} · worst case:{" "}
          {money(st["worst_case_spin_cost_usd"])}
        </p>
        <p>
          Outstanding spins: {String(st["outstanding_spins"] ?? "?")} · worst-case obligation:{" "}
          {money(st["worst_case_obligation_usd"])}
        </p>
        <p>
          Unused paid credits: {String(st["unused_paid_credits"] ?? 0)} (
          {money(st["unused_paid_credits_usd"])}) · owed prizes: {String(st["owed_prizes"] ?? 0)} (
          {money(st["owed_prizes_usd"])})
        </p>
        <p>
          Confirmed purchases: {String(st["confirmed_purchases"] ?? 0)} (
          {money(st["confirmed_purchases_usd"])}) · reserves: {money(st["reserves_usd"])}
        </p>
        {(
          (st["catalog_problems"] as { problem: string; prize_id: string }[] | undefined) ?? []
        ).map((p, i) => (
          <p key={i} className="text-destructive">
            {p.problem}
          </p>
        ))}
        {((st["unverified_costs"] as string[] | undefined) ?? []).map((c) => (
          <p key={c} className="text-destructive">
            Unverified cost: {c}
          </p>
        ))}
      </Card>
      <Card title="Sponsored budgets (burn / grant / free entry)">
        {((st["budgets"] as Record<string, unknown>[] | undefined) ?? []).map((b) => (
          <p key={String(b["id"])}>
            {String(b["source"])} · {String(b["name"])}: ${String(b["committed_usd"])} of $
            {String(b["funded_usd"])} committed{b["active"] ? "" : " (inactive)"}
          </p>
        ))}
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            className="h-9 rounded border border-input bg-background px-2"
            value={budget.source}
            onChange={(e) => setBudget({ ...budget, source: e.target.value })}
          >
            <option value="burn">burn</option>
            <option value="grant">grant</option>
            <option value="free_entry">free_entry</option>
          </select>
          <Input
            placeholder="name"
            value={budget.name}
            onChange={(e) => setBudget({ ...budget, name: e.target.value })}
          />
          <Input
            placeholder="funded USD"
            value={budget.funded}
            onChange={(e) => setBudget({ ...budget, funded: e.target.value })}
          />
          <Input
            placeholder="pause threshold USD"
            value={budget.threshold}
            onChange={(e) => setBudget({ ...budget, threshold: e.target.value })}
          />
        </div>
        <Input
          placeholder="evidence (where the funds are held)"
          value={budget.evidence}
          onChange={(e) => setBudget({ ...budget, evidence: e.target.value })}
        />
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() =>
            void run(
              "budget",
              () =>
                saveBudget({
                  data: {
                    source: budget.source as "burn",
                    name: budget.name,
                    fundedUsd: Number(budget.funded),
                    pauseThresholdUsd: Number(budget.threshold),
                    evidence: budget.evidence,
                    active: true,
                  },
                }),
              "Budget saved",
            )
          }
        >
          Add budget
        </Button>
      </Card>
      <Card title="Operating costs (unknown = unverified, never zero)">
        {((data?.costs ?? []) as Record<string, unknown>[]).map((c) => (
          <p key={String(c["id"])}>
            {String(c["category"])} · {String(c["basis"])} · {String(c["description"])}:{" "}
            {c["amount_usd"] == null ? "unverified" : `$${String(c["amount_usd"])}`}
          </p>
        ))}
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            className="h-9 rounded border border-input bg-background px-2"
            value={cost.category}
            onChange={(e) => setCost({ ...cost, category: e.target.value })}
          >
            {["gas", "vrf", "provider", "hosting", "support", "other"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <select
            className="h-9 rounded border border-input bg-background px-2"
            value={cost.basis}
            onChange={(e) => setCost({ ...cost, basis: e.target.value })}
          >
            {["per_spin", "per_draw", "monthly", "one_time"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <Input
            placeholder="description"
            value={cost.description}
            onChange={(e) => setCost({ ...cost, description: e.target.value })}
          />
          <Input
            placeholder="USD (empty = unknown)"
            value={cost.amount}
            onChange={(e) => setCost({ ...cost, amount: e.target.value })}
          />
        </div>
        <Input
          placeholder="evidence (invoice, explorer average…)"
          value={cost.evidence}
          onChange={(e) => setCost({ ...cost, evidence: e.target.value })}
        />
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() =>
            void run(
              "cost",
              () =>
                recordCost({
                  data: {
                    category: cost.category as "gas",
                    basis: cost.basis as "per_draw",
                    description: cost.description,
                    amountUsd: cost.amount === "" ? null : Number(cost.amount),
                    evidence: cost.evidence || null,
                  },
                }),
              "Cost recorded",
            )
          }
        >
          Record cost
        </Button>
      </Card>
      <Card title="Reserves for real-prize obligations">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            placeholder="USD (+ deposit / − withdrawal)"
            value={reserve.amount}
            onChange={(e) => setReserve({ ...reserve, amount: e.target.value })}
          />
          <Input
            placeholder="evidence"
            value={reserve.evidence}
            onChange={(e) => setReserve({ ...reserve, evidence: e.target.value })}
          />
        </div>
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() =>
            void run(
              "reserve",
              () =>
                saveReserve({
                  data: { amountUsd: Number(reserve.amount), evidence: reserve.evidence },
                }),
              "Reserve recorded",
            )
          }
        >
          Record
        </Button>
      </Card>
      <div className="md:col-span-2">
        <Card title="Prize costs, stock and funding proof">
          {(
            (data?.prizes ?? []) as {
              id: string;
              name: string;
              fulfillment_type: string;
              inventory: number | null;
            }[]
          ).map((p) => (
            <PrizeEconomicsRow
              key={p.id}
              prize={p}
              existing={((data?.prizeEconomics ?? []) as Record<string, unknown>[]).find(
                (e) => e["prize_id"] === p.id,
              )}
              save={(body) => run(`prize:${p.id}`, () => savePrize({ data: body }), "Saved")}
              busy={!!busy}
            />
          ))}
        </Card>
      </div>
    </div>
  );
}

type PrizeEconBody = {
  prizeId: string;
  acquisitionUsd: number | null;
  fulfillmentUsd: number | null;
  shippingUsd: number | null;
  costEvidence: string | null;
  stockVerifiedQty: number | null;
  stockEvidence: string | null;
  fundingReservedUsd: number;
  fundingEvidence: string | null;
};

function PrizeEconomicsRow({
  prize,
  existing,
  save,
  busy,
}: {
  prize: { id: string; name: string; fulfillment_type: string; inventory: number | null };
  existing: Record<string, unknown> | undefined;
  save: (b: PrizeEconBody) => Promise<void>;
  busy: boolean;
}) {
  const v = (k: string) => (existing?.[k] == null ? "" : String(existing[k]));
  const [f, setF] = useState({
    acq: v("acquisition_usd"),
    ful: v("fulfillment_usd"),
    ship: v("shipping_usd"),
    costEv: v("cost_evidence"),
    qty: v("stock_verified_qty"),
    stockEv: v("stock_evidence"),
    fund: v("funding_reserved_usd") || "0",
    fundEv: v("funding_evidence"),
  });
  const num = (s: string) => (s === "" ? null : Number(s));
  return (
    <div className="border-t border-border pt-2">
      <p className="font-semibold">
        {prize.name} · {prize.fulfillment_type} · stock {prize.inventory ?? "∞"}
      </p>
      {prize.fulfillment_type === "fulfillment_required" ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Input
            placeholder="acquisition $"
            value={f.acq}
            onChange={(e) => setF({ ...f, acq: e.target.value })}
          />
          <Input
            placeholder="fulfilment $"
            value={f.ful}
            onChange={(e) => setF({ ...f, ful: e.target.value })}
          />
          <Input
            placeholder="shipping $"
            value={f.ship}
            onChange={(e) => setF({ ...f, ship: e.target.value })}
          />
          <Input
            placeholder="cost evidence"
            value={f.costEv}
            onChange={(e) => setF({ ...f, costEv: e.target.value })}
          />
          <Input
            placeholder="verified stock on hand"
            value={f.qty}
            onChange={(e) => setF({ ...f, qty: e.target.value })}
          />
          <Input
            placeholder="stock evidence"
            value={f.stockEv}
            onChange={(e) => setF({ ...f, stockEv: e.target.value })}
          />
          <Input
            placeholder="reserved funding $"
            value={f.fund}
            onChange={(e) => setF({ ...f, fund: e.target.value })}
          />
          <Input
            placeholder="funding evidence"
            value={f.fundEv}
            onChange={(e) => setF({ ...f, fundEv: e.target.value })}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void save({
                prizeId: prize.id,
                acquisitionUsd: num(f.acq),
                fulfillmentUsd: num(f.ful),
                shippingUsd: num(f.ship),
                costEvidence: f.costEv || null,
                stockVerifiedQty: num(f.qty),
                stockEvidence: f.stockEv || null,
                fundingReservedUsd: Number(f.fund || 0),
                fundingEvidence: f.fundEv || null,
              })
            }
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          {prize.fulfillment_type === "unclassified"
            ? "Classify this prize in Prizes & odds first."
            : "Cost-free outcome — no fulfilment cost."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Operations
export function OpsPanel() {
  const ops = useServerFn(adminOps);
  const resolve = useServerFn(adminResolveAlert);
  const resolveConflict = useServerFn(adminResolveConflict);
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-ops"],
    queryFn: () => ops(),
    refetchInterval: 30_000,
  });
  const { busy, run } = useAction();
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <Card title="Open alerts">
        {error && <p className="text-destructive">{(error as Error).message}</p>}
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
          Re-scan
        </Button>
        {!data?.alerts.length && <p className="text-muted-foreground">No open alerts.</p>}
        {(data?.alerts ?? []).map((a) => (
          <div key={String(a["id"])} className="border-t border-border pt-2">
            <p className={a["severity"] === "critical" ? "text-destructive" : ""}>
              [{String(a["kind"])}] {String(a["message"])}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              since {String(a["raised_at"])}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "alert",
                  () => resolve({ data: { alertId: String(a["id"]) } }),
                  "Marked resolved",
                )
              }
            >
              Mark resolved
            </Button>
          </div>
        ))}
      </Card>
      <Card title="Settlement queue">
        <p className="text-muted-foreground">
          The protected worker (POST /api/cron/settle) settles these for every player. Credits are
          never refunded on a timeout.
        </p>
        {(data?.queue ?? []).map((b) => (
          <div key={String(b["id"])} className="border-t border-border pt-2 font-mono text-xs">
            <p>
              {String(b["id"]).slice(0, 8)} · {String(b["status"])} · {String(b["spin_count"])}{" "}
              spin(s) · {String(b["created_at"])}
            </p>
            {b["last_error"] ? <p className="text-destructive">{String(b["last_error"])}</p> : null}
            {b["status"] === "conflict" && (
              <div className="mt-1 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "conf",
                      () =>
                        resolveConflict({
                          data: { batchId: String(b["id"]), resolution: "confirmed" },
                        }),
                      "Re-checked: request is on-chain",
                    )
                  }
                >
                  Re-check: on-chain
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "noc",
                      () =>
                        resolveConflict({
                          data: { batchId: String(b["id"]), resolution: "not_onchain" },
                        }),
                      "Proven never mined: credits returned",
                    )
                  }
                >
                  Prove never mined
                </Button>
              </div>
            )}
          </div>
        ))}
        {!data?.queue.length && <p className="text-muted-foreground">Nothing in flight.</p>}
      </Card>
    </div>
  );
}
