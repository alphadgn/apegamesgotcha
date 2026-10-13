// Opened from the "Claim your stock certificate" email. The winner picks the wallet that should receive their stock
// certificate NFT (connect a wallet in this browser, or type the address twice), and the app sends it there.
// No sign-in here: the sealed one-time link is the key (`claimStockWithCode`). Shown on its own, without the site's
// menu or windows, and the code is taken out of the address bar straight away.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { claimStockWithCode, describeStockClaim } from "@/lib/stock.functions";

export const Route = createFileRoute("/claim-stock")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({ c: typeof s["c"] === "string" ? (s["c"] as string) : "" }),
  head: () => ({ meta: [{ title: "Claim your stock certificate — ApeGames Gotcha" }, { name: "robots", content: "noindex" }] }),
  component: ClaimStockPage,
});

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type Info = Awaited<ReturnType<typeof describeStockClaim>>;

const GOLD = "#f6c343";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

function ClaimStockPage() {
  const search = Route.useSearch();
  const [c] = useState(search.c);
  useEffect(() => {
    try {
      window.history.replaceState(null, "", "/claim-stock");
    } catch {
      /* not allowed */
    }
  }, []);

  const [info, setInfo] = useState<Info | { error: string } | null>(null);
  const [address, setAddress] = useState("");
  const [again, setAgain] = useState("");
  const [connected, setConnected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" | "error"; text?: string; tx?: string | null }>({ kind: "idle" });
  const provider = typeof window !== "undefined" ? ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) : null;

  const load = () => {
    if (!c) return setInfo({ error: "This link isn't complete. Open the latest email from ApeGames Gotcha again." });
    describeStockClaim({ data: { code: c } }).then(
      (r) => setInfo(r),
      (e: Error) => setInfo({ error: e.message.trim().startsWith("[") ? "This claim link isn't valid." : e.message }),
    );
  };
  useEffect(load, [c]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = connected ?? (isAddr(address) && address.trim().toLowerCase() === again.trim().toLowerCase() ? address.trim().toLowerCase() : null);

  const connect = async () => {
    if (!provider) return;
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts?.[0]) setConnected(accounts[0].toLowerCase());
    } catch {
      /* cancelled */
    }
  };

  const send = async () => {
    if (!target) return;
    setState({ kind: "busy", text: "Sending your certificate…" });
    try {
      const r = await claimStockWithCode({ data: { code: c, wallet: target } });
      setState({
        kind: "done",
        text: r.state === "sent" ? `Your stock certificate is in ${short(target)}.` : `Your stock certificate is on its way to ${short(target)}.`,
        tx: r.tx,
      });
    } catch (e) {
      setConfirming(false);
      setState({ kind: "error", text: (e as Error).message });
    }
  };

  const card = (body: React.ReactNode) => (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-lg border bg-card p-6 text-center" style={{ borderColor: `${GOLD}66` }}>
        <p className="site-title text-sm uppercase tracking-wide" style={{ color: GOLD }}>
          ApeGames Gotcha
        </p>
        <h1 className="mt-2 text-3xl font-bold">Claim your stock certificate</h1>
        {body}
      </div>
    </main>
  );

  if (info === null) return card(<p className="mt-4 text-muted-foreground">Checking the link…</p>);
  if ("error" in info) return card(<p className="mt-4 text-destructive">{info.error}</p>);
  const title = (
    <p className="mt-4 text-lg font-bold">
      {info.prize}
      {info.tokenId ? ` · certificate #${info.tokenId}` : ""}
    </p>
  );

  if (state.kind === "done" || info.state === "sent" || info.state === "sending")
    return card(
      <>
        {title}
        <p className="mt-3 text-lg font-bold text-primary">{state.kind === "done" || info.state === "sent" ? "Done!" : "On its way"}</p>
        <p className="mt-2">
          {state.text ?? (info.toWallet ? `Sent to ${short(info.toWallet)} on ${info.chain}.` : `Sent on ${info.chain}.`)}
        </p>
        {(state.tx ?? info.txUrl) && (
          <a className="mt-3 inline-block underline" href={(state.tx ?? info.txUrl)!} target="_blank" rel="noreferrer">
            See the transfer ↗
          </a>
        )}
        <p className="mt-4 text-xs text-muted-foreground">This link has done its job and no longer works. You can close this page.</p>
      </>,
    );

  if (info.state === "replaced")
    return card(
      <>
        {title}
        <p className="mt-4">
          This link no longer works: a newer claim link was emailed, or the certificate is being delivered another way. Use the latest email, or
          sign in to ApeGames Gotcha and open Your stock certificates on My Machine.
        </p>
      </>,
    );

  return card(
    <>
      {title}
      <p className="mt-2 text-sm text-muted-foreground">
        It's an NFT on {info.chain} that holds stock tokens in its own vault: whoever owns it controls the tokens inside. Choose the wallet
        that should receive it. Make sure you can use that wallet on {info.chain}; a transfer can't be undone.
      </p>
      {info.problem && <p className="mt-3 text-sm text-destructive">Last try: {info.problem}</p>}

      <div className="mt-5 space-y-3 text-left">
        {provider && (
          <button
            type="button"
            onClick={() => void connect()}
            className="min-h-12 w-full rounded-lg border px-3 py-2 text-base font-bold"
            style={{ borderColor: GOLD, color: GOLD }}
          >
            {connected ? `Using connected wallet ${short(connected)}` : "Use the wallet in this browser"}
          </button>
        )}
        {connected ? (
          <button type="button" className="text-xs underline" onClick={() => setConnected(null)}>
            Type an address instead
          </button>
        ) : (
          <>
            <label className="block text-sm">
              Wallet address
              <input
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setConfirming(false);
                }}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="block text-sm">
              Type it again to be sure
              <input
                value={again}
                onChange={(e) => {
                  setAgain(e.target.value);
                  setConfirming(false);
                }}
                onPaste={(e) => e.preventDefault()}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded border bg-background px-3 py-2 font-mono text-sm"
              />
            </label>
            {address && !isAddr(address) && <p className="text-xs text-destructive">That isn't a wallet address (0x followed by 40 characters).</p>}
            {isAddr(address) && again && address.trim().toLowerCase() !== again.trim().toLowerCase() && (
              <p className="text-xs text-destructive">The two addresses don't match.</p>
            )}
          </>
        )}
      </div>

      {confirming && target ? (
        <div className="mt-5 rounded border p-3 text-sm" style={{ borderColor: GOLD }}>
          <p>
            Send it to <b className="break-all font-mono">{target}</b> on {info.chain}? This can't be undone.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={state.kind === "busy"}
              onClick={() => void send()}
              className="min-h-12 rounded-lg px-4 py-2 font-bold disabled:opacity-70"
              style={{ backgroundColor: GOLD, color: "#141414" }}
            >
              {state.kind === "busy" ? state.text : "Yes, send it"}
            </button>
            <button type="button" disabled={state.kind === "busy"} onClick={() => setConfirming(false)} className="min-h-12 rounded-lg border px-4 py-2">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={!target}
          onClick={() => setConfirming(true)}
          className="mt-5 min-h-12 w-full rounded-lg px-4 py-2 text-base font-bold disabled:opacity-50"
          style={{ backgroundColor: GOLD, color: "#141414" }}
        >
          {target ? `Send to ${short(target)}` : "Choose a wallet"}
        </button>
      )}
      {state.kind === "error" && <p className="mt-3 break-words text-sm text-destructive">{state.text}</p>}
    </>,
  );
}
