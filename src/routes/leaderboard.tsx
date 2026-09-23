import { createFileRoute } from "@tanstack/react-router";
import { Leaderboard } from "@/components/Leaderboard";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — ApeGames Gotcha" },
      { name: "description", content: "Global campaign points ranking for Go ApeGames 2026." },
      { property: "og:title", content: "Leaderboard — ApeGames Gotcha" },
      { property: "og:description", content: "Who's leading the Go ApeGames 2026 campaign?" },
    ],
  }),
  component: () => (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-4xl font-bold">Global leaderboard</h1>
      <p className="mt-2 mb-8 text-muted-foreground">Campaign points from holdings, spins and verified adjustments.</p>
      <Leaderboard limit={200} />
    </main>
  ),
});
