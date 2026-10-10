import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** "live" (real on-chain spins) or "demo" (signed-in players' demo spins) — the admin picks which board is shown. */
export function useLeaderboardMode() {
  return useQuery({
    queryKey: ["leaderboard-mode"],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)("leaderboard_mode");
      return !error && data === "demo" ? ("demo" as const) : ("live" as const);
    },
    staleTime: 60_000,
  });
}

export function Leaderboard({ limit = 100 }: { limit?: number }) {
  const { data: mode } = useLeaderboardMode();
  const { data, isLoading } = useQuery({
    queryKey: ["leaderboard", limit, mode],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_leaderboard", { _limit: limit });
      if (error) throw error;
      return data ?? [];
    },
  });
  const label =
    mode === "demo" ? (
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">Demo leaderboard · free and granted demo spins</p>
    ) : null;
  if (isLoading) return <p className="font-mono text-sm text-muted-foreground">Loading ranks…</p>;
  if (!data?.length)
    return (
      <>
        {label}
        <p className="font-mono text-sm text-muted-foreground">No points on the board yet. Be the first.</p>
      </>
    );
  return (
    <>
    {label}
    <div className="overflow-hidden rounded border border-border">
      {data.map((r) => (
        <div key={r.user_id} className="flex items-center gap-3 border-b border-border bg-card px-3 py-3 last:border-0 sm:gap-4 sm:px-4">
          <span className={`w-12 shrink-0 whitespace-nowrap text-left font-mono text-base font-bold sm:text-lg ${r.rank <= 3 ? "text-primary" : "text-muted-foreground"}`}>#{r.rank}</span>
          {/* Name and points stack on phones so neither gets cut off. */}
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="w-full min-w-0 truncate text-left sm:w-auto">{r.display_name}</span>
            <span className="max-w-full text-left font-mono text-sm font-semibold sm:text-right sm:text-base">{Number(r.points).toLocaleString()} pts</span>
          </span>
        </div>
      ))}
    </div>
    </>
  );
}
