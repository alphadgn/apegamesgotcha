import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BoardTable,
  defaultSeason,
  QueryError,
  useBoard,
  useSeasons,
  type SeasonSummary,
} from "@/components/season/SeasonBoard";
import { formatPoints, publicName, PublicAvatar } from "@/components/season/PublicIdentity";

const db = supabase as unknown as SupabaseClient;
const PAGE = 25;

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — ApeGames Gotcha" },
      {
        name: "description",
        content: "Seasonal points ranking for Go ApeGames 2026, with published rules.",
      },
      { property: "og:title", content: "Leaderboard — ApeGames Gotcha" },
      { property: "og:description", content: "Who's leading this ApeGames season?" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LeaderboardPage,
});

const fmtDate = (s: string | null) =>
  s
    ? new Date(s).toLocaleString("en-US", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    : "—";

function LeaderboardPage() {
  const seasons = useSeasons();
  const [seasonId, setSeasonId] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!seasonId && seasons.data) setSeasonId(defaultSeason(seasons.data)?.id);
  }, [seasons.data, seasonId]);
  const season = seasons.data?.find((s) => s.id === seasonId);
  // Page 0 = top 10; later pages list the rest PAGE at a time.
  const limit = page === 0 ? 10 : PAGE;
  const offset = page === 0 ? 0 : 10 + (page - 1) * PAGE;
  const board = useBoard(seasonId, limit, offset);
  const total = board.data?.[0]?.total_count ?? 0;
  const pages = total <= 10 ? 1 : 1 + Math.ceil((total - 10) / PAGE);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <h1 className="text-3xl font-bold sm:text-4xl">Leaderboard</h1>
      <p className="mt-2 text-muted-foreground">
        Seasonal engagement points. Points can't be transferred and aren't redeemable for money, APE
        or tokens.
      </p>

      {seasons.error ? (
        <div className="mt-6">
          <QueryError error={seasons.error} onRetry={() => void seasons.refetch()} />
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <label htmlFor="season" className="text-sm text-muted-foreground">
            Season
          </label>
          <select
            id="season"
            className="h-10 rounded border border-input bg-background px-3 text-sm"
            value={seasonId ?? ""}
            onChange={(e) => {
              setSeasonId(e.target.value);
              setPage(0);
            }}
          >
            {(seasons.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.is_legacy ? "" : ` (${s.status})`}
              </option>
            ))}
          </select>
        </div>
      )}

      {season && <SeasonHeader season={season} />}
      {season && <MyStanding season={season} />}

      <section className="mt-6" aria-live="polite">
        {seasons.error ? null : board.error ? (
          <QueryError error={board.error} onRetry={() => void board.refetch()} />
        ) : board.isLoading || seasons.isLoading ? (
          <p className="font-mono text-sm text-muted-foreground">Loading ranks…</p>
        ) : !board.data?.length ? (
          <p className="font-mono text-sm text-muted-foreground">
            {page === 0 ? "No points on this board yet." : "No more players."}
          </p>
        ) : (
          <>
            {page === 0 && <h2 className="mb-2 text-xl font-bold">Top 10</h2>}
            <BoardTable rows={board.data} />
            {board.data[0]?.is_final && (
              <p className="mt-2 text-xs text-muted-foreground">
                Final standings · version {board.data[0].standings_version}
              </p>
            )}
          </>
        )}
        {pages > 1 && (
          <nav
            className="mt-4 flex items-center justify-center gap-3"
            aria-label="Leaderboard pages"
          >
            <button
              type="button"
              className="rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Previous
            </button>
            <span className="text-sm text-muted-foreground">
              {page === 0 ? "Top 10" : `Ranks ${offset + 1}–${Math.min(offset + PAGE, total)}`} of{" "}
              {total}
            </span>
            <button
              type="button"
              className="rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </nav>
        )}
      </section>

      {season && <RulesSection season={season} />}
    </main>
  );
}

function SeasonHeader({ season }: { season: SeasonSummary }) {
  if (season.is_legacy)
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Points earned before seasons began, kept exactly as recorded (archived).
      </p>
    );
  const now = Date.now();
  const ends = season.ends_at ? Date.parse(season.ends_at) : null;
  return (
    <div className="mt-4 grid gap-2 rounded border border-border bg-card p-4 text-sm sm:grid-cols-3">
      <div>
        <p className="text-muted-foreground">Starts</p>
        <p className="font-mono">{fmtDate(season.starts_at)}</p>
      </div>
      <div>
        <p className="text-muted-foreground">Cutoff (exclusive)</p>
        <p className="font-mono">{fmtDate(season.ends_at)}</p>
        {ends && ends > now && (
          <p className="text-xs text-muted-foreground">
            {Math.ceil((ends - now) / 3600_000)} h left
          </p>
        )}
      </div>
      <div>
        <p className="text-muted-foreground">Verification grace ends</p>
        <p className="font-mono">{fmtDate(season.settlement_deadline)}</p>
      </div>
    </div>
  );
}

function MyStanding({ season }: { season: SeasonSummary }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["my-standing", season.id, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await db.rpc("get_my_season_standing", { _season_id: season.id });
      if (error) throw new Error(error.message);
      return (
        (
          (data ?? []) as {
            rank: number;
            public_id: string;
            alias: string | null;
            avatar_key: string | null;
            total_points: string;
            total_count: number;
          }[]
        )[0] ?? null
      );
    },
  });
  if (!user) return null;
  if (q.error)
    return (
      <div className="mt-4">
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  if (q.isLoading) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-3 rounded border border-primary/50 bg-card p-4">
      {q.data ? (
        <>
          <PublicAvatar
            avatarKey={q.data.avatar_key}
            alias={q.data.alias}
            publicId={q.data.public_id}
            size={40}
          />
          <span className="font-semibold">{publicName(q.data.alias, q.data.public_id)}</span>
          <span className="font-mono">
            Rank #{Number(q.data.rank)} of {Number(q.data.total_count)} ·{" "}
            {formatPoints(q.data.total_points)} pts
          </span>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">You're not on this board yet.</span>
      )}
      <Link to="/profile" className="inline-flex min-h-11 items-center text-sm text-primary underline">
        Choose your public name
      </Link>
    </div>
  );
}

type RulesDoc = {
  legacy?: boolean;
  rules?: Record<string, unknown>;
  rules_hash?: string;
  odds?: {
    name: string;
    rarity: string;
    probability: number;
    remaining: number | null;
    bonus: number;
  }[];
  expected_bonus_per_spin?: number;
  expected_points_per_spin?: number;
  all_prizes_available?: boolean;
};

function RulesSection({ season }: { season: SeasonSummary }) {
  const q = useQuery({
    queryKey: ["season-rules", season.id],
    queryFn: async () => {
      const { data, error } = await db.rpc("get_season_rules", { _season_id: season.id });
      if (error) throw new Error(error.message);
      return data as RulesDoc;
    },
  });
  if (season.is_legacy) return null;
  const r = (q.data?.rules ?? season.rules) as Record<
    string,
    number | boolean | Record<string, number>
  >;
  const bonus = (r["rarity_bonus"] ?? {}) as Record<string, number>;
  return (
    <section className="mt-10 rounded border border-border bg-card p-5 text-left text-sm leading-relaxed">
      <h2 className="text-center text-2xl font-bold">How points work this season</h2>
      {q.error && <QueryError error={q.error} onRetry={() => void q.refetch()} />}
      <ul className="mt-3 list-disc space-y-1 pl-5">
        <li>
          <b>{String(r["nft_snapshot_points"] ?? 0)}</b> once per eligible 2025 ApeGames NFT you
          owned at the published snapshot block (claimed with a verified wallet; later sales don't
          change it).
        </li>
        <li>
          <b>{String(r["participation_points"] ?? 0)}</b> for every spin Chainlink VRF fulfils, when
          its request is confirmed on-chain before the cutoff. Paid, burn, granted and free-entry
          spins count the same.
        </li>
        <li>
          A prize bonus per spin: common <b>{bonus["common"] ?? 0}</b>, rare{" "}
          <b>{bonus["rare"] ?? 0}</b>, epic <b>{bonus["epic"] ?? 0}</b>, legendary{" "}
          <b>{bonus["legendary"] ?? 0}</b>
          {Object.keys((r["prize_bonus_overrides"] as Record<string, number>) ?? {}).length
            ? " (some prizes have published overrides)"
            : ""}
          .
        </li>
        <li>
          {r["social_enabled"] ? (
            <>
              <b>{String(r["social_share_points"])}</b> for a verified X post of a spin result, at
              most once per UTC day.
            </>
          ) : (
            "Share rewards are off this season."
          )}{" "}
          Referrals don't earn points.
        </li>
        <li>
          Limits: {String(r["daily_spin_limit"])} spins per rolling 24 hours and{" "}
          {String(r["season_spin_limit"])} per season. Pending, refunded and empty results score
          nothing.
        </li>
        <li>
          Ranking: total points, then whoever reached that total first, then a fixed internal order.
        </li>
      </ul>
      <p className="mt-3">
        Your rank depends on your NFT holdings, how much you play and the random prize bonuses
        Chainlink VRF draws — more spins mean more points. Prize stock is finite: as prizes run out,
        the odds of the rest change.
      </p>
      {q.data?.odds && (
        <div className="mt-4">
          <h3 className="text-center font-bold">Current odds (from the prize pool right now)</h3>
          <ul className="mt-2 space-y-1">
            {q.data.odds.map((o) => (
              <li key={o.name} className="flex justify-between gap-2 font-mono text-xs">
                <span>
                  {o.name} ({o.rarity}){o.remaining != null ? ` · ${o.remaining} left` : ""}
                </span>
                <span>
                  {(o.probability * 100).toFixed(2)}% · +{o.bonus}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Expected per spin right now: {q.data.expected_bonus_per_spin} bonus +{" "}
            {String(r["participation_points"])} participation ≈ {q.data.expected_points_per_spin}{" "}
            points.
            {q.data.all_prizes_available
              ? " This holds only while every prize is still in stock."
              : " Some prizes are out of stock, so this differs from the launch odds."}
          </p>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        Points are non-transferable engagement scores with no guaranteed cash, APE or $GAMES value,
        and nothing is paid out automatically. Any future leaderboard prizes will be announced
        separately with fixed, pre-funded allocations and rank/tie rules. Rules are frozen when the
        season starts (rules hash{" "}
        <span className="break-all font-mono">
          {q.data?.rules_hash ?? season.rules_hash ?? "—"}
        </span>
        ).
      </p>
    </section>
  );
}
