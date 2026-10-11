import { createFileRoute, Link } from "@tanstack/react-router";
import { CONTACT_EMAIL } from "@/lib/contact-email";

const DESCRIPTION =
  "ApeGames Gotcha is a fun gotcha machine from the ApeGames team, built by Devs0ng0, LLC, with musical scores by @MyDeadFriendz.";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — ApeGames Gotcha" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "About — ApeGames Gotcha" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <div className="rounded border border-border bg-background/80 p-6 shadow-2xl backdrop-blur-sm sm:p-8">
        <h1 className="text-3xl font-bold sm:text-4xl">About ApeGames Gotcha</h1>
        <p className="mt-4 text-base leading-relaxed sm:text-lg">
          The ApeGames Gotcha machine is a fun machine from the ApeGames team. It was built by
          Devs0ng0, LLC and plays musical scores by <b>@MyDeadFriendz</b>. Every spin can land
          digital prizes and redeemable physical prizes, and every point counts toward the{" "}
          <Link to="/leaderboard" className="underline">
            leaderboard competition
          </Link>
          .
        </p>
        <p className="mt-6 text-sm text-muted-foreground">
          Questions? Email{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex h-11 items-center rounded-lg px-5 font-bold"
          style={{ backgroundColor: "#f6c343", color: "#141414" }}
        >
          Spin the machine
        </Link>
      </div>
    </main>
  );
}
