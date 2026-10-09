import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  adminAdjustPoints,
  adminFindPlayer,
  adminListSeasons,
  adminPlayerLedger,
  adminReverseEntry,
} from "@/lib/seasons.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, KV, useAction } from "./common";

type Found = {
  profile: {
    id: string;
    public_id: string;
    public_alias: string | null;
    display_name: string | null;
  };
  wallets: { address: string }[];
  scores: { season_id: string; total_points: string }[];
};
type Entry = {
  id: string;
  amount: string;
  reward_subtype: string;
  source_type: string;
  source_id: string;
  effective_at: string;
  reverses_id: string | null;
  reversal_reason: string | null;
};

/** Audited reversals and adjustments. Reversals reference an original award and can't exceed what remains. */
export function LedgerPanel() {
  const find = useServerFn(adminFindPlayer);
  const ledgerFn = useServerFn(adminPlayerLedger);
  const reverse = useServerFn(adminReverseEntry);
  const adjust = useServerFn(adminAdjustPoints);
  const seasonsFn = useServerFn(adminListSeasons);
  const seasons = useQuery({ queryKey: ["admin-seasons"], queryFn: () => seasonsFn() });
  const { busy, run } = useAction();
  const [q, setQ] = useState("");
  const [player, setPlayer] = useState<Found | null>(null);
  const [seasonId, setSeasonId] = useState("");
  const [rows, setRows] = useState<Entry[]>([]);
  const [adj, setAdj] = useState({ amount: "", reason: "" });

  const load = async (sid: string, uid: string) =>
    setRows((await ledgerFn({ data: { userId: uid, seasonId: sid } })) as Entry[]);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="player email or public id (ape_…)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button
          disabled={!!busy || q.length < 3}
          onClick={() =>
            run(
              "find",
              async () => {
                const r = (await find({ data: { q } })) as Found | null;
                setPlayer(r);
                if (!r) throw new Error("No player found");
              },
              () => "Found",
            )
          }
        >
          Find
        </Button>
      </div>
      {player && (
        <Card title={player.profile.public_alias ?? player.profile.public_id}>
          <KV k="Public id" v={player.profile.public_id} />
          <KV k="Wallets" v={player.wallets.map((w) => w.address).join(", ") || "none"} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded border border-input bg-background px-2 text-sm"
              value={seasonId}
              onChange={(e) => {
                setSeasonId(e.target.value);
                if (e.target.value) void load(e.target.value, player.profile.id);
              }}
            >
              <option value="">Pick a season…</option>
              {((seasons.data ?? []) as { id: string; name: string; status: string }[])
                .filter((s) => s.status !== "draft")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
            </select>
          </div>
          {seasonId && (
            <>
              <div className="mt-3 grid gap-2 sm:grid-cols-[120px_1fr_auto]">
                <Input
                  placeholder="+/- points"
                  value={adj.amount}
                  onChange={(e) => setAdj({ ...adj, amount: e.target.value })}
                />
                <Input
                  placeholder="reason (required, audited)"
                  value={adj.reason}
                  onChange={(e) => setAdj({ ...adj, reason: e.target.value })}
                />
                <Button
                  size="sm"
                  disabled={!!busy || !adj.amount || adj.reason.length < 3}
                  onClick={() =>
                    run(
                      "adj",
                      async () => {
                        await adjust({
                          data: {
                            userId: player.profile.id,
                            seasonId,
                            amount: adj.amount,
                            reason: adj.reason,
                          },
                        });
                        setAdj({ amount: "", reason: "" });
                        await load(seasonId, player.profile.id);
                      },
                      () => "Adjusted",
                    )
                  }
                >
                  Adjust
                </Button>
              </div>
              <div className="mt-3 divide-y divide-border font-mono text-xs">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                  >
                    <span>
                      #{r.id} {r.reward_subtype} · {r.source_type}:{r.source_id.slice(0, 18)} ·{" "}
                      {r.effective_at.slice(0, 19)}
                      {r.reverses_id ? ` · reverses #${r.reverses_id} (${r.reversal_reason})` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <b>{r.amount}</b>
                      {!r.reverses_id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={!!busy}
                          onClick={() => {
                            const reason = prompt("Reason for this reversal (required, audited)");
                            if (!reason) return;
                            const amount =
                              prompt(
                                "Points to reverse (leave empty for everything that remains)",
                              ) || null;
                            void run(
                              "rev",
                              async () => {
                                await reverse({ data: { ledgerId: r.id, amount, reason } });
                                await load(seasonId, player.profile.id);
                              },
                              () => "Reversed",
                            );
                          }}
                        >
                          Reverse
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
                {!rows.length && <p className="py-2 text-muted-foreground">No entries.</p>}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
