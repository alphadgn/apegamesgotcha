import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Leaderboard } from "@/components/Leaderboard";
import { DemoGotchaMachine } from "@/components/gotcha/DemoGotchaMachine";
import type { GotchaPrize } from "@/components/gotcha/GotchaMachine";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ApeGames Gotcha — Spin, Earn, Climb" },
      { name: "description", content: "Hold ApeGames NFTs, burn Level 4+ for free spins, win prizes and climb the Go ApeGames 2026 leaderboard before Charleston." },
      { property: "og:title", content: "ApeGames Gotcha — Spin, Earn, Climb" },
      { property: "og:description", content: "Hold, burn, spin and climb the Go ApeGames 2026 leaderboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const steps = [
  { n: "01", t: "Link wallet", d: "Sign in, then verify your ApeChain wallet with a free signature." },
  { n: "02", t: "Earn holding points", d: "Every 2025 ApeGames NFT you hold earns points weighted by its Level." },
  { n: "03", t: "Burn or buy a spin", d: "Burn a Level 4+ NFT for a free spin, or buy one when checkout opens." },
  { n: "04", t: "Climb to Charleston", d: "Prizes and points stack on the global board until the event snapshot." },
];

function Index() {
  const { data: prizes } = useQuery({
    queryKey: ["public-prizes"],
    queryFn: async () => {
      const { data } = await supabase.from("prizes").select("id, name, rarity, points, weight, inventory").eq("active", true).order("created_at");
      return (data ?? []) as GotchaPrize[];
    },
  });
  return (
    <main className="min-h-screen overflow-hidden">
      <div className="mx-auto max-w-6xl px-4 pb-24">
      <section className="py-12 md:py-16">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">Go ApeGames 2026 · Pre-event</p>
        <h1 className="mt-4 text-5xl font-bold leading-[0.95] md:text-7xl">
          Pull the lever.<br /><span className="text-primary">Climb the board.</span>
        </h1>
        <p className="mt-6 max-w-lg text-lg text-muted-foreground">
          The official gacha for the Go ApeGames 2026 launch. Hold, burn and spin to stack points before Charleston.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg"><Link to="/dashboard">Open my machine</Link></Button>
          <Button asChild size="lg" variant="outline"><Link to="/leaderboard">View leaderboard</Link></Button>
        </div>
      </section>

      <section className="mb-16">
        <DemoGotchaMachine prizes={prizes} />
      </section>

      <section className="grid gap-px overflow-hidden rounded border border-border bg-border md:grid-cols-4">
        {steps.map((s) => (
          <div key={s.n} className="bg-card p-6">
            <span className="font-mono text-sm text-primary">{s.n}</span>
            <h3 className="mt-2 text-lg font-bold">{s.t}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{s.d}</p>
          </div>
        ))}
      </section>

      <section className="mt-16">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-3xl font-bold">Top apes</h2>
          <Link to="/leaderboard" className="font-mono text-sm text-primary">Full board →</Link>
        </div>
        <Leaderboard limit={10} />
      </section>
      </div>
    </main>
  );
}
