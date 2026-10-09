import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { formatPoints, publicName, PublicAvatar } from "./PublicIdentity";

// Untyped access for RPCs added by recent migrations (generated types can lag behind).
const db = supabase as unknown as SupabaseClient;

export type SeasonSummary = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "settling" | "finalized";
  is_legacy: boolean;
  starts_at: string | null;
  ends_at: string | null;
  settlement_deadline: string | null;
  rules: Record<string, unknown>;
  rules_hash: string | null;
  finalized_at: string | null;
  standings_version: number | null;
  standings_export_hash: string | null;
};

export type BoardRow = {
  rank: number;
  public_id: string;
  alias: string | null;
  avatar_key: string | null;
  total_points: string;
  nft_points: string;
  participation_points: string;
  prize_points: string;
  social_points: string;
  adjustment_points: string;
  legacy_points: string;
  total_count: number;
  standings_version: number | null;
  is_final: boolean;
};

export function useSeasons() {
  return useQuery({
    queryKey: ["seasons"],
    retry: 1,
    queryFn: async () => {
      const { data, error } = await db.rpc("list_seasons");
      if (error) throw new Error(error.message);
      return (data ?? []) as SeasonSummary[];
    },
    staleTime: 60_000,
  });
}

/** Active season first, then one being settled, then the latest finalized, then the legacy archive. */
export function defaultSeason(seasons: SeasonSummary[] | undefined) {
  if (!seasons?.length) return undefined;
  return (
    seasons.find((s) => s.status === "active") ??
    seasons.find((s) => s.status === "settling") ??
    seasons.find((s) => s.status === "finalized" && !s.is_legacy) ??
    seasons.find((s) => s.is_legacy)
  );
}

export function useBoard(seasonId: string | undefined, limit: number, offset: number) {
  return useQuery({
    queryKey: ["board", seasonId, limit, offset],
    retry: 1,
    enabled: !!seasonId,
    queryFn: async () => {
      const { data, error } = await db.rpc("get_season_leaderboard", {
        _season_id: seasonId,
        _limit: limit,
        _offset: offset,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as BoardRow[]).map((r) => ({
        ...r,
        rank: Number(r.rank),
        total_count: Number(r.total_count),
      }));
    },
  });
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded border border-destructive/60 bg-card p-4 text-sm">
      <p className="font-semibold text-destructive">Couldn't load the standings.</p>
      <p className="mt-1 text-muted-foreground">
        {(error as Error)?.message ?? "Unknown error"} — this is not an empty board.
      </p>
      <button type="button" className="mt-2 underline" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function BoardTable({
  rows,
  highlightPublicId,
}: {
  rows: BoardRow[];
  highlightPublicId?: string | undefined;
}) {
  return (
    <ol className="overflow-hidden rounded border border-border">
      {rows.map((r) => (
        <li
          key={r.public_id}
          className={`flex items-center gap-3 border-b border-border px-3 py-3 last:border-0 sm:gap-4 sm:px-4 ${r.public_id === highlightPublicId ? "bg-primary/15" : "bg-card"}`}
        >
          <span
            className={`w-12 shrink-0 whitespace-nowrap text-left font-mono text-base font-bold sm:text-lg ${r.rank <= 3 ? "text-primary" : "text-muted-foreground"}`}
          >
            #{r.rank}
          </span>
          <PublicAvatar avatarKey={r.avatar_key} alias={r.alias} publicId={r.public_id} />
          {/* Name and points stack on phones so long (bigint) totals never push the page sideways. */}
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="w-full min-w-0 truncate text-left sm:w-auto">{publicName(r.alias, r.public_id)}</span>
            <span className="min-w-0 max-w-full break-all text-left font-mono text-sm font-semibold sm:text-right sm:text-base">
              {formatPoints(r.total_points)} pts
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Compact top-N board for the home page (current season, or the archive if none is live). */
export function TopBoard({ limit = 10 }: { limit?: number }) {
  const seasons = useSeasons();
  const season = defaultSeason(seasons.data);
  const board = useBoard(season?.id, limit, 0);
  if (seasons.error)
    return <QueryError error={seasons.error} onRetry={() => void seasons.refetch()} />;
  if (board.error) return <QueryError error={board.error} onRetry={() => void board.refetch()} />;
  if (seasons.isLoading || board.isLoading)
    return <p className="font-mono text-sm text-muted-foreground">Loading ranks…</p>;
  if (!season)
    return <p className="font-mono text-sm text-muted-foreground">No season has started yet.</p>;
  return (
    <div>
      <p className="mb-2 text-sm text-muted-foreground">
        {season.name}
        {season.is_legacy ? "" : season.status === "active" ? " · live" : ` · ${season.status}`}
      </p>
      {board.data?.length ? (
        <BoardTable rows={board.data} />
      ) : (
        <p className="font-mono text-sm text-muted-foreground">
          No points on this board yet. Be the first.
        </p>
      )}
    </div>
  );
}
