import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Leaderboard } from "@/components/Leaderboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ApeGames Gotcha — Spin, Earn, Climb" },
      { name: "description", content: "Hold ApeGames NFTs, burn Level 4+ for free spins, win prizes and climb the Go ApeGames 2026 leaderboard before Charleston." },
      { property: "og:title", content: "ApeGames Gotcha — Spin, Earn, Climb" },
      { property: "og:description", content: "Hold, burn, spin and climb the Go ApeGames 2026 leaderboard." },
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
  return (
    <main className="mx-auto max-w-6xl px-4 pb-24">
      <section className="grid gap-10 py-16 md:grid-cols-[1.3fr_1fr] md:items-center">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">Go ApeGames 2026 · Pre-event</p>
          <h1 className="mt-4 text-5xl font-bold leading-[0.95] md:text-7xl">
            Pull the lever.<br /><span className="text-primary">Climb the board.</span>
          </h1>
          <p className="mt-6 max-w-lg text-lg text-muted-foreground">
            The official gacha for the Go ApeGames 2026 launch. Hold, burn and spin to stack points before Charleston.
          </p>
          <div className="mt-8 flex gap-3">
            <Button asChild size="lg"><Link to="/dashboard">Open my machine</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/leaderboard">View leaderboard</Link></Button>
          </div>
        </div>
        <div className="relative mx-auto aspect-[3/4] w-full max-w-xs rounded-t-[8rem] border-4 border-primary bg-card p-6">
          <div className="grid h-2/3 grid-cols-3 gap-3 rounded-t-[6rem] border border-border bg-background p-6 pt-12">
            {["bg-rarity-common", "bg-rarity-rare", "bg-rarity-epic", "bg-rarity-legendary", "bg-accent", "bg-primary"].map((c, i) => (
              <div key={i} className={`aspect-square rounded-full ${c} opacity-90`} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="h-12 w-12 rounded-full border-4 border-accent" />
            <div className="h-10 w-20 rounded bg-background" />
          </div>
        </div>
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
    </main>
  );
}
