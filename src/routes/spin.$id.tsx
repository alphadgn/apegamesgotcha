import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPublicSpin } from "@/lib/draws.functions";
import { PublicAvatar, publicName } from "@/components/season/PublicAvatar";
import { prizeArt, TorchEmblem } from "@/components/gotcha/icons";
import { TAGLINE } from "@/components/gotcha/ShareSpins";

export const Route = createFileRoute("/spin/$id")({
  head: () => ({
    meta: [
      { title: "A Gotcha pull — ApeGames Gotcha" },
      { name: "description", content: TAGLINE },
      { property: "og:title", content: "ApeGames Gotcha pull" },
      { property: "og:description", content: TAGLINE },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SpinPage,
});

const RARITY: Record<string, string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

function SpinPage() {
  const { id } = Route.useParams();
  const fn = useServerFn(getPublicSpin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["public-spin", id],
    queryFn: () => fn({ data: { id } }),
    retry: false,
  });
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <div className="mx-auto w-fit">
        <TorchEmblem width={72} height={72} />
      </div>
      {isLoading ? (
        <p className="mt-6 font-mono text-sm text-muted-foreground">Loading…</p>
      ) : error || !data ? (
        <p className="mt-6 text-muted-foreground">This pull isn't available.</p>
      ) : (
        <div className="mt-6 rounded border border-primary bg-card p-6">
          <div className="mx-auto w-fit">
            {(() => {
              const Art = prizeArt(data.prize_name, data.rarity);
              return <Art width={140} height={140} />;
            })()}
          </div>
          <p className="mt-3 font-mono text-xs uppercase text-muted-foreground">
            {RARITY[data.rarity] ?? data.rarity}
          </p>
          <h1 className="text-3xl font-bold">{data.prize_name}</h1>
          {data.seasonal ? (
            <p className="mt-2 font-mono text-sm">
              +{data.participation_points} spin + {data.bonus_points} bonus
              {data.season ? ` · ${data.season.name}` : ""}
            </p>
          ) : (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              No seasonal points for this pull
            </p>
          )}
          {data.player.public_id && (
            <p className="mt-4 flex items-center justify-center gap-2 text-sm">
              <PublicAvatar
                avatarKey={data.player.avatar_key}
                publicId={data.player.public_id}
                size={24}
              />
              {publicName(data.player.alias, data.player.public_id)}
            </p>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Drawn on-chain by Chainlink VRF
            {data.request_tx ? ` · request ${data.request_tx.slice(0, 10)}…` : ""}
          </p>
        </div>
      )}
      <p className="mt-8 font-display text-xl font-bold uppercase">{TAGLINE}</p>
      <Link
        to="/"
        className="mt-3 inline-block rounded bg-primary px-4 py-2 font-medium text-primary-foreground"
      >
        Take your spin
      </Link>
    </main>
  );
}
