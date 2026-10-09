import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PublicAvatar, publicName } from "@/components/season/PublicAvatar";
import { formatPoints } from "@/lib/seasonRules";

/** Compact top list for the current (or most recent) season. Public aliases and opaque ids only. */
export function Leaderboard({ limit = 100 }: { limit?: number }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["leaderboard", limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_leaderboard", { _limit: limit });
      if (error) throw error;
      return data ?? [];
    },
  });
  if (error) {
    return (
      <p className="font-mono text-sm text-destructive">
        Couldn't load ranks ({(error as Error).message}).{" "}
        <button type="button" className="underline" onClick={() => void refetch()}>Retry</button>
      </p>
    );
  }
  if (isLoading) return <p className="font-mono text-sm text-muted-foreground">Loading ranks…</p>;
  if (!data?.length) return <p className="font-mono text-sm text-muted-foreground">No points on the board yet. Be the first.</p>;
  return (
    <div className="overflow-hidden rounded border border-border">
      {data.map((r) => (
        <div key={r.public_id} className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 last:border-0">
          <span className={`w-10 font-mono text-lg font-bold ${Number(r.rank) <= 3 ? "text-primary" : "text-muted-foreground"}`}>#{r.rank}</span>
          <PublicAvatar avatarKey={r.avatar_key} publicId={r.public_id} />
          <span className="flex-1 truncate text-left">{publicName(r.display_name?.startsWith("Ape ") ? null : r.display_name, r.public_id)}</span>
          <span className="font-mono font-semibold">{formatPoints(r.points)} pts</span>
        </div>
      ))}
    </div>
  );
}
