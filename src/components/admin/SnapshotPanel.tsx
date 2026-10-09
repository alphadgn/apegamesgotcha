import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminCollections,
  adminIndexCollection,
  adminMarkCollectionReady,
  adminSaveCollection,
} from "@/lib/nft.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, KV, QueryError, useAction } from "./common";

type Col = {
  id: string;
  label: string;
  edition: string;
  chain_id: number;
  contract: string;
  deploy_block: number | null;
  snapshot_block: number | null;
  snapshot_block_hash: string | null;
  status: string;
  indexed_through_block: number | null;
  notes: string | null;
  indexed_tokens: number;
  open_claims: number;
};

export function SnapshotPanel() {
  const list = useServerFn(adminCollections);
  const save = useServerFn(adminSaveCollection);
  const index = useServerFn(adminIndexCollection);
  const ready = useServerFn(adminMarkCollectionReady);
  const { data, error, refetch } = useQuery({
    queryKey: ["admin-collections"],
    queryFn: () => list(),
  });
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<Col> | null>(null);

  const indexAll = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await index({ data: { id } });
      void refetch();
      if (r.done) return `Indexed through block ${r.indexed_through}`;
    }
    return "Still indexing — run again to continue";
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        Historical recognition uses ownership at a frozen snapshot block, verified with an archive
        RPC (configure <span className="font-mono">snapshot.archive_rpc_urls</span>). The seeded
        ApeChain contract is only a<b> candidate</b>: confirm it is the intended 2025 collection,
        enter the deploy block, snapshot block and its hash, index Transfer logs, then mark it
        ready. Ready collections are frozen.
      </p>
      <QueryError error={error} />
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          setEdit({
            label: "",
            edition: "2025",
            chain_id: 33139,
            contract: "",
            deploy_block: null,
            snapshot_block: null,
            snapshot_block_hash: null,
            notes: null,
          })
        }
      >
        Add collection
      </Button>
      {edit && (
        <Card title={edit.id ? "Edit collection" : "New collection"}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="label"
              value={edit.label ?? ""}
              onChange={(e) => setEdit({ ...edit, label: e.target.value })}
            />
            <Input
              placeholder="edition (e.g. 2025)"
              value={edit.edition ?? ""}
              onChange={(e) => setEdit({ ...edit, edition: e.target.value })}
            />
            <Input
              placeholder="chain id"
              type="number"
              value={edit.chain_id ?? ""}
              onChange={(e) => setEdit({ ...edit, chain_id: +e.target.value })}
            />
            <Input
              placeholder="contract 0x…"
              value={edit.contract ?? ""}
              onChange={(e) => setEdit({ ...edit, contract: e.target.value })}
            />
            <Input
              placeholder="deploy block"
              type="number"
              value={edit.deploy_block ?? ""}
              onChange={(e) =>
                setEdit({ ...edit, deploy_block: e.target.value ? +e.target.value : null })
              }
            />
            <Input
              placeholder="snapshot block"
              type="number"
              value={edit.snapshot_block ?? ""}
              onChange={(e) =>
                setEdit({ ...edit, snapshot_block: e.target.value ? +e.target.value : null })
              }
            />
            <Input
              className="sm:col-span-2"
              placeholder="snapshot block hash 0x…"
              value={edit.snapshot_block_hash ?? ""}
              onChange={(e) => setEdit({ ...edit, snapshot_block_hash: e.target.value || null })}
            />
            <Input
              className="sm:col-span-2"
              placeholder="notes"
              value={edit.notes ?? ""}
              onChange={(e) => setEdit({ ...edit, notes: e.target.value || null })}
            />
          </div>
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
                        label: edit.label!,
                        edition: edit.edition!,
                        chain_id: edit.chain_id!,
                        contract: edit.contract!,
                        deploy_block: edit.deploy_block ?? null,
                        snapshot_block: edit.snapshot_block ?? null,
                        snapshot_block_hash: edit.snapshot_block_hash ?? null,
                        notes: edit.notes ?? null,
                      },
                    });
                    setEdit(null);
                    void refetch();
                  },
                  () => "Saved",
                )
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {((data ?? []) as Col[]).map((c) => (
        <Card
          key={c.id}
          title={c.label}
          actions={
            <span
              className={`rounded px-2 py-0.5 font-mono text-xs uppercase ${c.status === "ready" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {c.status}
            </span>
          }
        >
          <KV k="Edition / chain" v={`${c.edition} · ${c.chain_id}`} />
          <KV k="Contract" v={c.contract} />
          <KV
            k="Deploy → snapshot block"
            v={`${c.deploy_block ?? "?"} → ${c.snapshot_block ?? "?"}`}
            warn={c.snapshot_block == null}
          />
          <KV
            k="Snapshot block hash"
            v={c.snapshot_block_hash ?? "not set"}
            warn={!c.snapshot_block_hash}
          />
          <KV
            k="Indexed through"
            v={`${c.indexed_through_block ?? "—"} (${c.indexed_tokens} tokens)`}
            warn={c.snapshot_block != null && (c.indexed_through_block ?? -1) < c.snapshot_block}
          />
          <KV k="Open claims" v={c.open_claims} />
          {c.notes && <p className="mt-2 text-xs text-muted-foreground">{c.notes}</p>}
          {c.status !== "ready" && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEdit(c)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  run(
                    "idx",
                    () => indexAll(c.id),
                    (m) => m,
                  )
                }
              >
                {busy === "idx" ? "Indexing…" : "Index Transfer logs"}
              </Button>
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  confirm(
                    `Confirm ${c.contract} on chain ${c.chain_id} is the intended ${c.edition} collection and the snapshot is final?`,
                  ) &&
                  run(
                    "ready",
                    () => ready({ data: { id: c.id, confirm: true } }).then(() => void refetch()),
                    () => "Marked ready",
                  )
                }
              >
                Confirm & mark ready
              </Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
