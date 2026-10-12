// Opened inside a phone wallet app's own browser (MetaMask, Coinbase Wallet, Trust…) from "Add wallet" in the
// player's usual browser. It shows which ApeGames Gotcha account the wallet will join, the wallet signs a free
// message, and the wallet is linked to that account — no WalletConnect, no sign-in here. Afterwards it sends the
// player back to their usual browser, where they are signed in. This page is shown on its own (no site menu or
// sign-in), so nobody wanders into a signed-out copy of the site inside the wallet app. See `linkWalletWithCode`.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { checkWalletLink, describeWalletLink, linkWalletWithCode } from "@/lib/app.functions";

export const Route = createFileRoute("/link-wallet")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({ c: typeof s["c"] === "string" ? (s["c"] as string) : "" }),
  head: () => ({ meta: [{ title: "Add wallet — ApeGames Gotcha" }, { name: "robots", content: "noindex" }] }),
  component: LinkWalletPage,
});

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const GOLD = "#f6c343";

/** Where "Back" goes: the player's usual browser (where they're signed in), opened from inside the wallet app. */
function returnTarget() {
  const target = `${window.location.host}/dashboard`;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return `x-safari-https://${target}`; // opens Safari
  if (/Android/i.test(navigator.userAgent)) return `intent://${target}#Intent;scheme=https;end`; // default browser
  return null;
}

/** Leave nothing behind in the wallet app: disconnect the site from the wallet, then close or blank this page. */
async function closeOut(provider: Eip1193 | null | undefined) {
  try {
    // MetaMask and others: drop this site's permission to see the wallet (ignored where unsupported).
    await Promise.race([
      provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }),
      new Promise((r) => window.setTimeout(r, 800)),
    ]);
  } catch {
    /* not supported: nothing to drop */
  }
  try {
    window.close(); // works where the wallet app opened this as a closable window
  } catch {
    /* not allowed */
  }
  // Otherwise replace the page (and its history entry) with a blank one.
  window.location.replace("about:blank");
}

function LinkWalletPage() {
  const search = Route.useSearch();
  // Read the code once, then take it out of the address bar and history right away.
  const [c] = useState(search.c);
  useEffect(() => {
    try {
      window.history.replaceState(null, "", "/link-wallet");
    } catch {
      /* not allowed */
    }
  }, []);
  const [info, setInfo] = useState<{ username: string; message: string } | { error: string } | null>(null);
  const [provider, setProvider] = useState<Eip1193 | null | undefined>(undefined);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string }>({ kind: "idle" });

  useEffect(() => {
    if (!c) return setInfo({ error: "This link isn't complete. Start again from Add wallet in ApeGames Gotcha." });
    describeWalletLink({ data: { code: c } }).then(
      (r) => setInfo({ username: r.username, message: r.message }),
      (e: Error) =>
        setInfo({
          error: e.message.trim().startsWith("[")
            ? "This link isn't valid. Start again from Add wallet in ApeGames Gotcha."
            : e.message,
        }),
    );
  }, [c]);

  useEffect(() => {
    // Wallet browsers inject their wallet a moment after the page starts.
    const find = () => (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
    if (find()) return setProvider(find());
    const t = window.setTimeout(() => setProvider(find()), 1200);
    return () => window.clearTimeout(t);
  }, []);

  // Finished but left open: close it out anyway after a minute and a half.
  useEffect(() => {
    if (state.kind !== "done") return;
    const t = window.setTimeout(() => void closeOut(provider), 90_000);
    return () => window.clearTimeout(t);
  }, [state.kind, provider]);

  const sign = async () => {
    if (!provider || !info || "error" in info) return;
    setState({ kind: "busy", text: "Approve in your wallet…" });
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error("No wallet account was shared.");
      // Already linked? Then there's nothing to sign and nothing changes (it's never counted twice).
      const { status } = await checkWalletLink({ data: { code: c, address } });
      if (status === "mine")
        return setState({ kind: "done", text: `Wallet ${short(address)} is already linked to ${info.username}, so nothing changed.` });
      if (status === "other")
        throw new Error(`Wallet ${short(address)} is already linked to another ApeGames Gotcha account, so it can't be added here.`);
      const signature = (await provider.request({ method: "personal_sign", params: [info.message, address] })) as string;
      setState({ kind: "busy", text: "Checking the signature…" });
      const r = await linkWalletWithCode({ data: { code: c, address, signature } });
      setState({
        kind: "done",
        text: r.alreadyLinked
          ? `Wallet ${short(address)} was already linked to ${info.username}.`
          : `Wallet ${short(address)} is now linked to ${info.username}.`,
      });
    } catch (e) {
      const m = (e as { message?: string })?.message ?? "Something went wrong";
      setState({ kind: "error", text: /reject|denied|cancel/i.test(m) ? "Signature cancelled, so the wallet wasn't added." : m });
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-lg border bg-card p-6 text-center" style={{ borderColor: `${GOLD}66` }}>
        <p className="site-title text-sm uppercase tracking-wide" style={{ color: GOLD }}>
          ApeGames Gotcha
        </p>
        <h1 className="mt-2 text-3xl font-bold">Add this wallet</h1>

        {info === null ? (
          <p className="mt-4 text-muted-foreground">Checking the link…</p>
        ) : "error" in info ? (
          <p className="mt-4 text-destructive">{info.error}</p>
        ) : state.kind === "done" ? (
          <>
            <p className="mt-4 text-lg font-bold text-primary">Done!</p>
            <p className="mt-2">{state.text}</p>
            <button
              type="button"
              onClick={() => {
                const target = returnTarget();
                if (target) window.location.href = target;
                window.setTimeout(() => void closeOut(provider), target ? 600 : 0);
              }}
              className="mt-6 flex min-h-12 w-full items-center justify-center rounded-lg px-4 py-2 text-base font-bold"
              style={{ backgroundColor: GOLD, color: "#141414" }}
            >
              Back to ApeGames Gotcha
            </button>
            <p className="mt-3 text-xs text-muted-foreground">
              This page closes itself and the link stops working. You can also switch back to the browser you started
              in (on iPhone, tap “◀ Safari” at the top left).
            </p>
          </>
        ) : (
          <>
            <p className="mt-4">
              This adds the wallet to the ApeGames Gotcha account <b>{info.username}</b>.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your wallet signs a free message to prove it's yours. No transaction, no fees. If this isn't your account,
              close this page.
            </p>
            {provider === undefined ? (
              <p className="mt-4 text-muted-foreground">Looking for your wallet…</p>
            ) : !provider ? (
              <p className="mt-4 text-muted-foreground">
                Open this page inside your wallet app's browser (MetaMask, Coinbase Wallet, Trust…) to add that wallet.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => void sign()}
                disabled={state.kind === "busy"}
                className="mt-6 min-h-12 w-full rounded-lg px-4 py-2 text-base font-bold disabled:opacity-70"
                style={{ backgroundColor: GOLD, color: "#141414" }}
              >
                {state.kind === "busy" ? state.text : "Sign to add this wallet"}
              </button>
            )}
            {state.kind === "error" && <p className="mt-3 break-words text-sm text-destructive">{state.text}</p>}
          </>
        )}
      </div>
    </main>
  );
}
