import { createFileRoute } from "@tanstack/react-router";
import { Leaderboard } from "@/components/Leaderboard";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — ApeGames Gotcha" },
      { name: "description", content: "Global campaign points ranking for Go ApeGames 2026." },
      { property: "og:title", content: "Leaderboard — ApeGames Gotcha" },
      { property: "og:description", content: "Who's leading the Go ApeGames 2026 campaign?" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <h1 className="text-3xl font-bold sm:text-4xl">Global leaderboard</h1>
      <p className="mt-2 mb-8 text-muted-foreground">Campaign points from holdings, spins and verified adjustments.</p>
      <Leaderboard limit={200} />
    </main>
  ),
});
