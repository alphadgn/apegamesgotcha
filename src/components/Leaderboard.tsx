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
        <div key={r.user_id} className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 last:border-0">
          <span className={`w-10 font-mono text-lg font-bold ${r.rank <= 3 ? "text-primary" : "text-muted-foreground"}`}>#{r.rank}</span>
          <span className="flex-1 truncate">{r.display_name}</span>
          <span className="font-mono font-semibold">{Number(r.points).toLocaleString()} pts</span>
        </div>
      ))}
    </div>
  );
}
