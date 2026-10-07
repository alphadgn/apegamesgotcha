import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { openSignIn } from "@/components/wallet/walletUi";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — ApeGames Gotcha" },
      {
        name: "description",
        content:
          "Sign in with email, Google or your wallet. New players get a wallet automatically.",
      },
      { property: "og:title", content: "Sign in — ApeGames Gotcha" },
      {
        property: "og:description",
        content:
          "Sign in with email, Google or your wallet. New players get a wallet automatically.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

/** Sign-in page (pages that need an account redirect here). Opens the same sign-in window as everywhere else. */
function AuthPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (user) void navigate({ to: "/dashboard" });
    else openSignIn();
  }, [user, loading, navigate]);

  return (
    <main className="min-h-[calc(100vh-3.5rem)] overflow-hidden px-4 py-16">
      <div className="mx-auto max-w-sm rounded border border-border bg-background/80 p-6 shadow-2xl backdrop-blur-sm">
        <h1 className="text-3xl font-bold">Sign in</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Use email, Google or your wallet. If you don't have a Web3 wallet yet, one is created for
          you and becomes your default wallet — you can add or change wallets later in My Machine.
        </p>
        <Button className="mt-6 w-full" onClick={() => openSignIn()} disabled={loading}>
          Sign in
        </Button>
      </div>
    </main>
  );
}
