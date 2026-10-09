import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminDefaultRules,
  adminListSeasons,
  adminSaveSeasonDraft,
  adminSeasonAction,
  adminSeasonCsv,
} from "@/lib/seasons.functions";
import { adminCollections } from "@/lib/nft.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, KV, QueryError, downloadText, useAction } from "./common";

type Season = Record<string, unknown> & {
  id: string;
  slug: string;
  name: string;
  status: string;
  is_legacy: boolean;
  starts_at: string | null;
  ends_at: string | null;
  settlement_deadline: string | null;
  grace_period: string;
  rules: unknown;
  rules_version: number;
  rules_hash: string | null;
  snapshot_config: { collection_ids?: string[] };
  activation_errors: string[];
  unresolved: Record<string, number> | null;
  versions: {
    version: number;
    export_hash: string;
    ledger_watermark: string;
    finalized_at: string;
    supersedes_version: number | null;
    correction_reason: string | null;
  }[];
};

const toLocal = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
const fromLocal = (v: string) => (v ? new Date(`${v}:00Z`).toISOString() : null); // inputs are UTC

export function SeasonsPanel() {
  const list = useServerFn(adminListSeasons);
  const save = useServerFn(adminSaveSeasonDraft);
  const act = useServerFn(adminSeasonAction);
  const csv = useServerFn(adminSeasonCsv);
  const defaults = useServerFn(adminDefaultRules);
  const cols = useServerFn(adminCollections);
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({ queryKey: ["admin-seasons"], queryFn: () => list() });
  const collections = useQuery({ queryKey: ["admin-collections"], queryFn: () => cols() });
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<null | {
    id?: string;
    slug: string;
    name: string;
    starts: string;
    ends: string;
    deadline: string;
    grace: number;
    rules: string;
    collections: string[];
  }>(null);

  const startNew = async () => {
    const r = await defaults();
    setEdit({
      slug: "",
      name: "",
      starts: "",
      ends: "",
      deadline: "",
      grace: 72,
      rules: JSON.stringify(r, null, 2),
      collections: [],
    });
  };
  const startEdit = (s: Season) =>
    setEdit({
      id: s.id,
      slug: s.slug,
      name: s.name,
      starts: toLocal(s.starts_at),
      ends: toLocal(s.ends_at),
      deadline: toLocal(s.settlement_deadline),
      grace: parseInt(String(s.grace_period), 10) || 72,
      rules: JSON.stringify(s.rules, null, 2),
      collections: s.snapshot_config?.collection_ids ?? [],
    });

  const after = () => {
    void refetch();
    void qc.invalidateQueries({ queryKey: ["seasons"] });
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Draft seasons can be edited freely; activation freezes rules, window and snapshot (edits
        then prepare a future season). Dates are entered in <b>UTC</b>; the end is exclusive. No
        production dates or snapshot blocks are pre-filled.
      </p>
      <QueryError error={error} />
      <Button size="sm" onClick={() => void startNew()}>
        New draft season
      </Button>

      {edit && (
        <Card title={edit.id ? "Edit draft" : "New draft"}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="slug (e.g. season-1)"
              value={edit.slug}
              onChange={(e) => setEdit({ ...edit, slug: e.target.value })}
            />
            <Input
              placeholder="name"
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
            <label className="text-xs">
              Start (UTC)
              <Input
                type="datetime-local"
                value={edit.starts}
                onChange={(e) => setEdit({ ...edit, starts: e.target.value })}
              />
            </label>
            <label className="text-xs">
              End, exclusive (UTC)
              <Input
                type="datetime-local"
                value={edit.ends}
                onChange={(e) => setEdit({ ...edit, ends: e.target.value })}
              />
            </label>
            <label className="text-xs">
              Settlement deadline (UTC)
              <Input
                type="datetime-local"
                value={edit.deadline}
                onChange={(e) => setEdit({ ...edit, deadline: e.target.value })}
              />
            </label>
            <label className="text-xs">
              Verification grace (hours)
              <Input
                type="number"
                value={edit.grace}
                onChange={(e) => setEdit({ ...edit, grace: +e.target.value })}
              />
            </label>
          </div>
          <p className="mt-3 text-xs font-bold">
            Snapshot collections (must be “ready” to activate with NFT points)
          </p>
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            {(collections.data ?? []).map((c) => (
              <label key={c.id as string} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={edit.collections.includes(c.id as string)}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      collections: e.target.checked
                        ? [...edit.collections, c.id as string]
                        : edit.collections.filter((x) => x !== c.id),
                    })
                  }
                />
                {c.label as string} ({c.status as string})
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs font-bold">
            Rules (points are integer strings; prize_bonus_overrides: prize id → points, "0"
            allowed)
          </p>
          <Textarea
            className="mt-1 h-72 font-mono text-xs"
            value={edit.rules}
            onChange={(e) => setEdit({ ...edit, rules: e.target.value })}
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run(
                  "save",
                  async () => {
                    await save({
                      data: {
                        ...(edit.id ? { id: edit.id } : {}),
                        slug: edit.slug,
                        name: edit.name,
                        starts_at: fromLocal(edit.starts),
                        ends_at: fromLocal(edit.ends),
                        settlement_deadline: fromLocal(edit.deadline),
                        grace_hours: edit.grace,
                        rules: JSON.parse(edit.rules),
                        collection_ids: edit.collections,
                      },
                    });
                    setEdit(null);
                    after();
                  },
                  () => "Draft saved",
                )
              }
            >
              Save draft
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {((data ?? []) as Season[]).map((s) => (
        <Card
          key={s.id}
          title={`${s.name} (${s.slug})`}
          actions={
            <span
              className={`rounded px-2 py-0.5 font-mono text-xs uppercase ${s.status === "active" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {s.status}
              {s.is_legacy ? " · legacy" : ""}
            </span>
          }
        >
          <KV k="Window (UTC)" v={`${s.starts_at ?? "—"} → ${s.ends_at ?? "—"} (exclusive)`} />
          <KV
            k="Settlement deadline"
            v={s.settlement_deadline ?? "—"}
            warn={
              !!s.settlement_deadline &&
              Date.parse(s.settlement_deadline) < Date.now() &&
              s.status !== "finalized"
            }
          />
          <KV
            k="Rules"
            v={`v${s.rules_version}${s.rules_hash ? ` · ${s.rules_hash.slice(0, 12)}…` : " · not frozen"}`}
          />
          {s.status === "draft" && s.activation_errors.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-destructive">
              {s.activation_errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {s.unresolved && (
            <KV
              k="Blocking finalization"
              v={Object.entries(s.unresolved)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
              warn={Object.values(s.unresolved).some((v) => Number(v) > 0)}
            />
          )}
          {s.versions.map((v) => (
            <KV
              key={v.version}
              k={`Standings v${v.version}${v.supersedes_version ? ` (supersedes v${v.supersedes_version}: ${v.correction_reason})` : ""}`}
              v={`${v.export_hash.slice(0, 16)}… · watermark ${v.ledger_watermark}`}
            />
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            {s.status === "draft" && !s.is_legacy && (
              <>
                <Button size="sm" variant="outline" onClick={() => startEdit(s)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy || s.activation_errors.length > 0}
                  onClick={() =>
                    confirm(`Activate ${s.slug}? Rules, window and snapshot freeze permanently.`) &&
                    run(
                      "act",
                      () => act({ data: { id: s.id, action: "activate" } }).then(after),
                      () => "Season activated",
                    )
                  }
                >
                  Activate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    run("del", () =>
                      act({ data: { id: s.id, action: "delete_draft" } }).then(after),
                    )
                  }
                >
                  Delete draft
                </Button>
              </>
            )}
            {s.status === "active" && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  run(
                    "adv",
                    () => act({ data: { id: s.id, action: "advance" } }).then(after),
                    () => "Seasons past their cutoff moved to settling",
                  )
                }
              >
                Move ended seasons to settling
              </Button>
            )}
            {s.status === "settling" && (
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  confirm(
                    "Finalize? Standings become immutable (corrections create a superseding version).",
                  ) &&
                  run(
                    "fin",
                    () => act({ data: { id: s.id, action: "finalize" } }).then(after),
                    () => "Finalized",
                  )
                }
              >
                Finalize
              </Button>
            )}
            {(s.status === "active" || s.status === "settling") && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    run(
                      "bf",
                      () => act({ data: { id: s.id, action: "backfill_report" } }),
                      (r) => `Backfill dry run: ${JSON.stringify(r)}`,
                    )
                  }
                >
                  Backfill dry run
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const d = prompt("New settlement deadline (UTC, e.g. 2026-11-01T00:00:00Z)");
                    if (d)
                      void run("ext", () =>
                        act({
                          data: {
                            id: s.id,
                            action: "extend_deadline",
                            deadline: new Date(d).toISOString(),
                          },
                        }).then(after),
                      );
                  }}
                >
                  Extend deadline
                </Button>
              </>
            )}
            {s.status !== "draft" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(
                    "csv",
                    async () => {
                      const r = await csv({
                        data: {
                          id: s.id,
                          ...(s.versions.length
                            ? { version: s.versions[s.versions.length - 1]!.version }
                            : {}),
                        },
                      });
                      downloadText(`${s.slug}-standings.csv`, r.csv);
                    },
                    () => "CSV downloaded",
                  )
                }
              >
                Export CSV
              </Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
