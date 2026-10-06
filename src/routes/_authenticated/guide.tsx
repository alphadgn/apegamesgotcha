import { createFileRoute } from "@tanstack/react-router";
import { GuidePanel } from "@/components/guide/GuidePanel";

export const Route = createFileRoute("/_authenticated/guide")({
  head: () => ({
    meta: [
      { title: "Guide — ApeGames Gotcha" },
      { name: "description", content: "Ask the ApeGames guide about spins, prizes, NFTs and the Charleston event." },
      { property: "og:title", content: "Guide — ApeGames Gotcha" },
      { property: "og:description", content: "Ask the ApeGames guide about spins, prizes, NFTs and the Charleston event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => <GuidePanel />,
});

