// Opened inside a phone wallet app's own browser (MetaMask, Coinbase Wallet, Trust…) from "Add wallet" on the
// player's phone. The wallet signs a free verification message and is linked to the player who made the link —
// no WalletConnect and no sign-in needed here. See `linkWalletWithCode`.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { linkWalletWithCode } from "@/lib/app.functions";

export const Route = createFileRoute("/link-wallet")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    u: typeof s["u"] === "string" ? (s["u"] as string) : "",
    n: typeof s["n"] === "string" ? (s["n"] as string) : "",
  }),
  head: () => ({ meta: [{ title: "Add wallet — ApeGames Gotcha" }, { name: "robots", content: "noindex" }] }),
  component: LinkWalletPage,
});

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function LinkWalletPage() {
  const { u, n } = Route.useSearch();
  const [provider, setProvider] = useState<Eip1193 | null | undefined>(undefined);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });

  useEffect(() => {
    // Wallet browsers inject their wallet a moment after the page starts.
    const find = () => (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
    if (find()) return setProvider(find());
    const t = window.setTimeout(() => setProvider(find()), 1200);
    return () => window.clearTimeout(t);
  }, []);

  const valid = /^[0-9a-f-]{36}$/i.test(u) && /^[0-9a-f-]{36}$/i.test(n);

  const sign = async () => {
    if (!provider) return;
    setState({ kind: "busy", text: "Approve in your wallet…" });
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error("No wallet account was shared.");
      const message = `ApeGames Gotcha wallet verification\nUser: ${u}\nNonce: ${n}`;
      const signature = (await provider.request({ method: "personal_sign", params: [message, address] })) as string;
      setState({ kind: "busy", text: "Checking the signature…" });
      await linkWalletWithCode({ data: { userId: u, nonce: n, address, signature } });
      setState({ kind: "done", text: `Wallet ${short(address)} is now linked to your ApeGames Gotcha account.` });
    } catch (e) {
      const m = (e as { message?: string })?.message ?? "Something went wrong";
      setState({ kind: "error", text: /reject|denied|cancel/i.test(m) ? "Signature cancelled, so the wallet wasn't added." : m });
    }
  };

  return (
    <main className="mx-auto w-full max-w-md px-4 py-12">
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-3xl font-bold">Add this wallet</h1>
        {!valid ? (
          <p className="mt-4 text-muted-foreground">
            This link isn't complete. On ApeGames Gotcha, open My Machine → Add wallet and pick your wallet app again.
          </p>
        ) : state.kind === "done" ? (
          <>
            <p className="mt-4 text-lg font-bold text-primary">Done!</p>
            <p className="mt-2">{state.text}</p>
            <p className="mt-4 text-sm text-muted-foreground">
              Go back to ApeGames Gotcha in your usual browser: the wallet shows up there in a few seconds.
            </p>
          </>
        ) : provider === undefined ? (
          <p className="mt-4 text-muted-foreground">Looking for your wallet…</p>
        ) : !provider ? (
          <p className="mt-4 text-muted-foreground">
            Open this page inside your wallet app's browser (MetaMask, Coinbase Wallet, Trust…) to add that wallet.
          </p>
        ) : (
          <>
            <p className="mt-4 text-muted-foreground">
              Your wallet signs a free message to prove it's yours. No transaction, no fees.
            </p>
            <button
              type="button"
              onClick={() => void sign()}
              disabled={state.kind === "busy"}
              className="mt-6 min-h-12 w-full rounded-lg px-4 py-2 text-base font-bold disabled:opacity-70"
              style={{ backgroundColor: "#f6c343", color: "#141414" }}
            >
              {state.kind === "busy" ? state.text : "Sign to add this wallet"}
            </button>
            {state.kind === "error" && <p className="mt-3 break-words text-sm text-destructive">{state.text}</p>}
          </>
        )}
      </div>
    </main>
  );
}
