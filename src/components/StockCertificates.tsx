// "Your stock certificates" on My Machine, and the choice a winner makes for each one:
//   • Send to my wallet — the app sends the certificate NFT to one of the player's linked wallets right away;
//   • Email me a claim link — a one-time link goes to the account email; opening it, the winner picks a wallet.
// A stock certificate is an NFT whose own wallet holds stock tokens: whoever owns the NFT controls them.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { chooseStockDelivery, getMyStockCertificates, type StockStatus } from "@/lib/stock.functions";
import { Button } from "@/components/ui/button";

export const STOCK_QUERY_KEY = ["my-stock-certificates"] as const;

export function useMyStockCertificates(enabled = true) {
  const fn = useServerFn(getMyStockCertificates);
  return useQuery({
    queryKey: STOCK_QUERY_KEY,
    queryFn: () => fn(),
    enabled,
    staleTime: 15_000,
    // A certificate on its way: look again until it has arrived.
    refetchInterval: (q) => (q.state.data?.rows.some((r) => r.status === "sending") ? 5_000 : false),
  });
}

type StockData = NonNullable<ReturnType<typeof useMyStockCertificates>["data"]>;
export type MyStockCertificate = StockData["rows"][number];

const STATUS: Record<StockStatus, { label: string; tone: string }> = {
  unclaimed: { label: "Choose how to receive it", tone: "bg-destructive/20 text-destructive" },
  emailed: { label: "Claim link emailed", tone: "bg-primary/20 text-primary" },
  sending: { label: "On its way", tone: "bg-primary/20 text-primary" },
  sent: { label: "In your wallet", tone: "bg-muted text-muted-foreground" },
  failed: { label: "Not sent yet — try again", tone: "bg-destructive/20 text-destructive" },
};

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const kindName = (k: string | null) => (k === "glyph" ? "Glyph" : k === "privy" ? "Privy" : k ? k[0]!.toUpperCase() + k.slice(1) : "Wallet");

/** The two delivery choices and what happens next, for one stock certificate. */
export function StockChoice({ cert, wallets, email }: { cert: MyStockCertificate; wallets: StockData["wallets"]; email: string | null }) {
  const qc = useQueryClient();
  const choose = useServerFn(chooseStockDelivery);
  const [wallet, setWallet] = useState(() => wallets.find((w) => w.isDefault)?.address ?? wallets[0]?.address ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"wallet" | "email" | null>(null);
  const open = cert.status === "unclaimed" || cert.status === "emailed" || cert.status === "failed";

  const run = async (choice: "wallet" | "email") => {
    setBusy(choice);
    try {
      const r = await choose({ data: { id: cert.id, choice, ...(choice === "wallet" ? { wallet } : {}), origin: window.location.origin } });
      if (r.state === "emailed") toast.success(`Claim link sent to ${r.email}. Open the email to pick your wallet.`);
      else if (r.state === "sent") toast.success("Your stock certificate is in your wallet!");
      else toast.info("Your stock certificate is on its way. It shows up here as soon as it arrives.");
      setConfirming(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: STOCK_QUERY_KEY });
    }
  };

  return (
    <div className="space-y-3">
      {cert.status === "sent" && (
        <p className="text-sm">
          Sent to your wallet {short(cert.toWallet)} on {cert.chain}.{" "}
          {cert.txUrl && (
            <a className="underline" href={cert.txUrl} target="_blank" rel="noreferrer">
              See the transfer ↗
            </a>
          )}{" "}
          {cert.tokenUrl && (
            <a className="underline" href={cert.tokenUrl} target="_blank" rel="noreferrer">
              See the certificate ↗
            </a>
          )}
        </p>
      )}
      {cert.status === "sending" && (
        <p className="text-sm">
          On its way to {short(cert.toWallet)} on {cert.chain}…{" "}
          {cert.txUrl && (
            <a className="underline" href={cert.txUrl} target="_blank" rel="noreferrer">
              Follow the transfer ↗
            </a>
          )}
        </p>
      )}
      {cert.status === "emailed" && (
        <p className="text-sm">
          We emailed a one-time claim link to <b>{cert.emailedTo ?? email}</b>. Open it and pick the wallet that should receive the
          certificate. No email? Check spam, send a new link, or have it sent to your wallet now.
        </p>
      )}
      {cert.problem && <p className="text-sm text-destructive">{cert.problem}</p>}

      {open && (
        <div className="space-y-3 rounded border border-border p-3">
          <p className="text-sm font-bold">Send it to my wallet</p>
          {wallets.length ? (
            <div className="space-y-1" role="radiogroup" aria-label="Wallet">
              {wallets.map((w) => (
                <label key={w.address} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`stock-wallet-${cert.id}`}
                    checked={wallet === w.address}
                    onChange={() => {
                      setWallet(w.address);
                      setConfirming(false);
                    }}
                  />
                  <span className="font-mono">{short(w.address)}</span>
                  <span className="text-xs text-muted-foreground">
                    {kindName(w.kind)}
                    {w.isDefault ? " · default" : ""}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Link a wallet first (Wallets on My Machine), or use the email link.</p>
          )}
          {confirming ? (
            <div className="rounded border border-primary bg-primary/10 p-3 text-sm">
              <p>
                Send certificate{cert.tokenId ? ` #${cert.tokenId}` : ""} to <b className="font-mono">{short(wallet)}</b> on {cert.chain}? A
                transfer can't be undone, so make sure you can use this wallet on {cert.chain}.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Button disabled={!!busy} onClick={() => void run("wallet")}>
                  {busy === "wallet" ? "Sending…" : "Yes, send it"}
                </Button>
                <Button variant="outline" disabled={!!busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button className="w-full" disabled={!!busy || !wallet} onClick={() => setConfirming(true)}>
              Send to {wallet ? short(wallet) : "my wallet"}
            </Button>
          )}

          <div className="border-t border-border pt-3">
            <p className="text-sm font-bold">Or get it by email</p>
            {email ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  We email a one-time claim link to {email}. Open it on any device, choose the wallet, and we send the certificate there.
                </p>
                <Button variant="outline" className="mt-2 w-full" disabled={!!busy} onClick={() => void run("email")}>
                  {busy === "email" ? "Sending email…" : cert.status === "emailed" ? "Email me a new link" : "Email me a claim link"}
                </Button>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Your account has no email address, so this certificate can only go to a wallet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StockCertificates() {
  const { data, isLoading } = useMyStockCertificates();
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading || !data?.rows.length) return null;
  return (
    <section id="stock-certificates" className="rounded border border-primary/60 bg-card p-4 text-left sm:p-6">
      <h2 className="text-xl font-bold">Your stock certificates</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Each certificate is an NFT holding stock tokens in its own vault: whoever owns it controls the tokens inside. Have it sent straight to
        your wallet, or emailed as a claim link.
      </p>
      <ul className="mt-4 space-y-3">
        {data.rows.map((c) => {
          const st = STATUS[c.status];
          const needsChoice = c.status === "unclaimed" || c.status === "failed";
          return (
            <li key={c.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-primary/15 text-2xl" aria-hidden>
                  📈
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    {c.prize}
                    {c.tokenId ? ` · #${c.tokenId}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.chain} · won {new Date(c.wonAt).toLocaleDateString()}
                  </p>
                  <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.label}</span>
                </div>
                <Button size="sm" variant={needsChoice ? "default" : "outline"} onClick={() => setOpen(open === c.id ? null : c.id)}>
                  {open === c.id ? "Close" : needsChoice ? "Choose" : "Details"}
                </Button>
              </div>
              {open === c.id && (
                <div className="mt-3">
                  <StockChoice cert={c} wallets={data.wallets} email={data.email} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
