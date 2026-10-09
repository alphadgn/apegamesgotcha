import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminReviewShare,
  adminShareQueue,
  type ShareQueueItem as Share,
} from "@/lib/identity.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, QueryError, useAction } from "./common";

/**
 * Audited manual review of public X posts. Open the post yourself (we never fetch arbitrary URLs),
 * check the author is the linked account, the post time, and that it links this spin.
 */
export function SharesPanel() {
  const list = useServerFn(adminShareQueue);
  const review = useServerFn(adminReviewShare);
  const { data, error, refetch } = useQuery({ queryKey: ["admin-shares"], queryFn: () => list() });
  const { busy, run } = useAction();
  const [form, setForm] = useState<
    Record<string, { author: string; createdAt: string; refs: boolean; note: string }>
  >({});

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        Approve only after checking: the post is by the player's linked account, it was posted
        during the season and before submission, and it links this spin (
        <span className="font-mono">/spin/&lt;id&gt;</span>). Posts with an X API token configured
        are verified automatically. One reward per UTC day and per spin; approvals are final (use a
        ledger reversal to undo).
      </p>
      <QueryError error={error} />
      {!data?.length && <p className="text-sm text-muted-foreground">Queue is empty.</p>}
      {(data ?? ([] as Share[])).map((s) => {
        const f = form[s.id] ?? {
          author: s.x_accounts?.handle ?? "",
          createdAt: "",
          refs: false,
          note: "",
        };
        const set = (p: Partial<typeof f>) => setForm({ ...form, [s.id]: { ...f, ...p } });
        return (
          <Card key={s.id} title={`@${s.x_accounts?.handle ?? "?"} · ${s.award_day}`}>
            <a
              href={`https://x.com/i/status/${s.post_id}`}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-sm underline"
            >
              Open post {s.post_id} on x.com
            </a>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Spin {s.spin_id} · submitted {new Date(s.submitted_at).toISOString()}
            </p>
            {s.evidence?.last_api_error ? (
              <p className="font-mono text-xs text-destructive">API: {s.evidence.last_api_error}</p>
            ) : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Input
                placeholder="author handle as shown"
                value={f.author}
                onChange={(e) => set({ author: e.target.value })}
              />
              <Input
                type="datetime-local"
                title="Post time (UTC)"
                value={f.createdAt}
                onChange={(e) => set({ createdAt: e.target.value })}
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={f.refs}
                  onChange={(e) => set({ refs: e.target.checked })}
                />{" "}
                Links this spin
              </label>
              <Input
                className="sm:col-span-3"
                placeholder="note (recorded as evidence)"
                value={f.note}
                onChange={(e) => set({ note: e.target.value })}
              />
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={!!busy || !f.author || !f.createdAt}
                onClick={() =>
                  run(
                    `a:${s.id}`,
                    () =>
                      review({
                        data: {
                          id: s.id,
                          approve: true,
                          authorHandle: f.author,
                          postCreatedAt: new Date(`${f.createdAt}:00Z`).toISOString(),
                          referencesSpin: f.refs,
                          note: f.note || undefined,
                        },
                      }).then((r) => {
                        void refetch();
                        return r;
                      }),
                    (r) => `Result: ${(r as { status: string }).status}`,
                  )
                }
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  run(
                    `r:${s.id}`,
                    () =>
                      review({
                        data: {
                          id: s.id,
                          approve: false,
                          referencesSpin: false,
                          note: f.note || "Rejected in review",
                        },
                      }).then(() => void refetch()),
                    () => "Rejected",
                  )
                }
              >
                Reject
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
