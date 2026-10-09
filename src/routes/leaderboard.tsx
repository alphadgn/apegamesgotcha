import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { getLeaderboardPage, getMyStanding, getSeasons } from "@/lib/seasons.functions";
import { getMachineReadiness } from "@/lib/draws.functions";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { PublicAvatar, publicName } from "@/components/season/PublicAvatar";
import { SeasonRulesPanel } from "@/components/season/SeasonRulesPanel";
import { formatPoints, type SeasonRules } from "@/lib/seasonRules";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — ApeGames Gotcha" },
      { name: "description", content: "Season rankings for Go ApeGames 2026 — rules, cutoff and standings." },
      { property: "og:title", content: "Leaderboard — ApeGames Gotcha" },
      { property: "og:description", content: "Who's leading the Go ApeGames 2026 season?" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LeaderboardPage,
});

const PAGE = 25;
const statusLabel = { active: "Live", settling: "Settling", finalized: "Final" } as const;

function LeaderboardPage() {
  const seasonsFn = useServerFn(getSeasons);
  const pageFn = useServerFn(getLeaderboardPage);
  const mineFn = useServerFn(getMyStanding);
  const readyFn = useServerFn(getMachineReadiness);
  const { user } = useAuth();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: () => seasonsFn() });
  const [slug, setSlug] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Default: the live season, else the most recent non-legacy one, else the legacy archive.
  useEffect(() => {
    if (slug || !seasons.data?.length) return;
    const list = seasons.data;
    setSlug((list.find((s) => s.status === "active") ?? list.find((s) => !s.is_legacy) ?? list[0])!.slug);
  }, [seasons.data, slug]);
  const season = useMemo(() => seasons.data?.find((s) => s.slug === slug) ?? null, [seasons.data, slug]);

  const top = useQuery({ queryKey: ["board", slug, 0, 10], queryFn: () => pageFn({ data: { slug: slug!, offset: 0, limit: 10 } }), enabled: !!slug });
  const rest = useQuery({
    queryKey: ["board", slug, 10 + page * PAGE, PAGE],
    queryFn: () => pageFn({ data: { slug: slug!, offset: 10 + page * PAGE, limit: PAGE } }),
    enabled: !!slug && (top.data?.total ?? 0) > 10,
  });
  const mine = useQuery({ queryKey: ["my-standing", slug, user?.id], queryFn: () => mineFn({ data: { slug: slug! } }), enabled: !!slug && !!user });
  const ready = useQuery({ queryKey: ["machine-readiness"], queryFn: () => readyFn(), enabled: season?.status === "active" });

  const total = top.data?.total ?? 0;
  const pages = Math.max(0, Math.ceil((total - 10) / PAGE));
  const isRules = (r: unknown): r is SeasonRules => !!r && typeof r === "object" && (r as { schema?: number }).schema === 1;

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-4xl font-bold">Leaderboard</h1>
      {seasons.error ? (
        <ErrorBox message={(seasons.error as Error).message} retry={() => void seasons.refetch()} />
      ) : !seasons.data ? (
        <p className="mt-6 font-mono text-sm text-muted-foreground">Loading seasons…</p>
      ) : !seasons.data.length ? (
        <p className="mt-6 text-muted-foreground">No season has been published yet.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <label className="font-mono text-xs uppercase text-muted-foreground" htmlFor="season">Season</label>
            <select
              id="season"
              className="rounded border border-border bg-background px-3 py-2 text-sm"
              value={slug ?? ""}
              onChange={(e) => {
                setSlug(e.target.value);
                setPage(0);
              }}
            >
              {seasons.data.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name} — {statusLabel[s.status]}
                </option>
              ))}
            </select>
            {season && (
              <span className={`rounded px-2 py-1 font-mono text-xs uppercase ${season.status === "active" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {statusLabel[season.status]}
              </span>
            )}
          </div>
          {season && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              {season.ends_at ? `Cutoff ${new Date(season.ends_at).toUTCString()}` : ""}
              {season.status === "finalized" && season.standings_version ? ` · Final standings v${season.standings_version}` : ""}
            </p>
          )}

          {user && mine.data && (
            <div className="mx-auto mt-6 max-w-md rounded border border-primary bg-card p-4">
              <p className="font-mono text-xs uppercase text-muted-foreground">Your place</p>
              <p className="font-display text-3xl font-bold">#{mine.data["rank"]} <span className="text-base font-normal text-muted-foreground">of {mine.data["players"]}</span></p>
              <p className="font-mono text-sm">{formatPoints(mine.data["total_points"])} pts</p>
            </div>
          )}
          {user && mine.error && <ErrorBox message={(mine.error as Error).message} />}

          <h2 className="mt-8 text-2xl font-bold">Top 10</h2>
          <Board query={top} startRank={1} />

          {total > 10 && (
            <>
              <h2 className="mt-8 text-xl font-bold">Everyone else</h2>
              <Board query={rest} startRank={11 + page * PAGE} />
              <div className="mt-3 flex items-center justify-center gap-3">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span className="font-mono text-xs">Page {page + 1} of {pages}</span>
                <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </>
          )}

          {season && isRules(season.rules) && (
            <div className="mt-10">
              <SeasonRulesPanel
                rules={season.rules}
                startsAt={season.starts_at}
                endsAt={season.ends_at}
                deadline={season.settlement_deadline}
                graceHours={season.grace_hours}
                rulesHash={season.rules_hash}
                projection={season.status === "active" ? ready.data?.projection ?? null : null}
              />
            </div>
          )}
          {season?.is_legacy && (
            <p className="mt-8 text-sm text-muted-foreground">Pre-season points, archived exactly as they were earned. They don't carry into seasons.</p>
          )}
          {season?.status === "finalized" && season.standings_export_hash && (
            <p className="mt-4 break-all font-mono text-[10px] text-muted-foreground">Standings export hash: {season.standings_export_hash}</p>
          )}
        </>
      )}
    </main>
  );
}

type BoardQuery = {
  data?: { rows: { rank: string; public_id: string; alias: string | null; avatar_key: string | null; total_points: string }[]; total: number } | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
};

function Board({ query, startRank }: { query: BoardQuery; startRank: number }) {
  if (query.error) return <ErrorBox message={(query.error as Error).message} retry={() => void query.refetch()} />;
  if (query.isLoading || !query.data) return <p className="mt-3 font-mono text-sm text-muted-foreground">Loading ranks…</p>;
  if (!query.data.rows.length) return <p className="mt-3 font-mono text-sm text-muted-foreground">{startRank === 1 ? "No points on the board yet. Be the first." : "Nobody here yet."}</p>;
  return (
    <div className="mt-3 overflow-hidden rounded border border-border">
      {query.data.rows.map((r) => (
        <div key={r.public_id} className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 last:border-0">
          <span className={`w-12 text-left font-mono text-lg font-bold ${Number(r.rank) <= 3 ? "text-primary" : "text-muted-foreground"}`}>#{r.rank}</span>
          <PublicAvatar avatarKey={r.avatar_key} publicId={r.public_id} />
          <span className="flex-1 truncate text-left">{publicName(r.alias, r.public_id)}</span>
          <span className="font-mono font-semibold">{formatPoints(r.total_points)} pts</span>
        </div>
      ))}
    </div>
  );
}

function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="mt-4 rounded border border-destructive bg-card p-4 text-sm">
      <p className="text-destructive">Couldn't load the leaderboard: {message}</p>
      {retry && <Button size="sm" variant="outline" className="mt-2" onClick={retry}>Try again</Button>}
    </div>
  );
}
