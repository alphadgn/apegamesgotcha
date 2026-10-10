import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function Leaderboard({ limit = 100 }: { limit?: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["leaderboard", limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_leaderboard", { _limit: limit });
      if (error) throw error;
      return data ?? [];
    },
  });
  if (isLoading) return <p className="font-mono text-sm text-muted-foreground">Loading ranks…</p>;
  if (!data?.length) return <p className="font-mono text-sm text-muted-foreground">No points on the board yet. Be the first.</p>;
  return (
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
  );
}
