import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getWalletNonce, linkWallet, syncNfts, claimBurn, setDefaultWallet, getMySpinBalance } from "@/lib/app.functions";
import { openBurn, requestLinkWallet } from "@/components/wallet/walletUi";
import { readPendingBurn, useBurnConfirmer } from "@/components/wallet/BurnPanel";
import { usePrivyPublicConfig } from "@/components/wallet/WalletHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerGotchaMachine } from "@/components/gotcha/PlayerGotchaMachine";
import { useAuth } from "@/hooks/useAuth";
import { SafeSection } from "@/components/SafeSection";
import { IrlPrizes } from "@/components/IrlPrizes";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "My Machine — ApeGames Gotcha" },
      { name: "description", content: "Your wallet, NFTs, spins and points." },
      { property: "og:title", content: "My Machine — ApeGames Gotcha" },
      { property: "og:description", content: "Your wallet, NFTs, spins and points." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const rarityClass: Record<string, string> = {
  common: "text-rarity-common border-rarity-common",
  rare: "text-rarity-rare border-rarity-rare",
  epic: "text-rarity-epic border-rarity-epic",
  legendary: "text-rarity-legendary border-rarity-legendary",
};

type DashboardSpin = {
  id: string;
  status: string;
  prize_name: string | null;
  points: number | null;
  rarity: string | null;
};

type WalletRow = { id: string; address: string; is_default?: boolean; kind?: string };

function useMyData() {
  const balanceFn = useServerFn(getMySpinBalance);
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user!.id;
      const [wallets, holdings, ledger, credits, spins, nftCfg, prizes] = await Promise.all([
        supabase.from("wallets").select("*").eq("user_id", uid),
        supabase.from("nft_holdings").select("*").eq("user_id", uid).order("token_id"),
        supabase.from("points_ledger").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
        balanceFn(),
        supabase.from("spins").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
        supabase.from("app_config").select("value").eq("key", "nft").single(),
        supabase.from("prizes").select("id, name, rarity, points, weight, inventory").eq("active", true).order("created_at"),
      ]);
      return {
        wallets: wallets.data ?? [],
        holdings: holdings.data ?? [],
        ledger: ledger.data ?? [],
        credits,
        spins: (spins.data ?? []) as unknown as DashboardSpin[],
        prizes: prizes.data ?? [],
        nft: (nftCfg.data?.value ?? {}) as { burn_min_level?: number; burn_address?: string; opensea_url?: string },
      };
    },
  });
}

function Dashboard() {
  const qc = useQueryClient();
  const { data } = useMyData();
  const refresh = () => qc.invalidateQueries();
  const nonceFn = useServerFn(getWalletNonce);
  const linkFn = useServerFn(linkWallet);
  const defaultFn = useServerFn(setDefaultWallet);
  const { data: privyCfg } = usePrivyPublicConfig();
  const syncFn = useServerFn(syncNfts);
  const burnFn = useServerFn(claimBurn);
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [burnTx, setBurnTx] = useState("");
  const [burnToken, setBurnToken] = useState("");

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  // Add a wallet: through Privy (any wallet, incl. mobile) when it's set up, otherwise a browser-extension signature.
  const addWallet = () => (privyCfg?.privy_app_id ? requestLinkWallet() : connectWallet());

  const makeDefault = (address: string) => run(`default:${address}`, async () => {
    await defaultFn({ data: { address } });
    toast.success("Default wallet updated");
    refresh();
  });

  const connectWallet = () => run("wallet", async () => {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No wallet found. Install MetaMask or another browser wallet.");
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    const { message } = await nonceFn();
    const signature = await eth.request({ method: "personal_sign", params: [message, address] });
    await linkFn({ data: { address, signature } });
    toast.success("Wallet linked");
    refresh();
  });

  const doSync = () => run("sync", async () => {
    const r = await syncFn();
    toast.success(`Found ${r.found} NFT(s), +${r.awarded} points`);
    refresh();
  });

  // A burn that was still confirming when the page closed is finished here (the spin is added once it confirms).
  const confirmBurn = useBurnConfirmer();
  useEffect(() => {
    const pending = readPendingBurn();
    if (!pending) return;
    let cancelled = false;
    void confirmBurn(pending, () => cancelled)
      .then((ok) => {
        if (ok && !cancelled) {
          toast.success("Burn confirmed — 1 free spin added");
          refresh();
        }
      })
      .catch((e) => toast.error((e as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual fallback: the player already sent the NFT to the burn address themselves.
  const doBurn = () => run("burn", async () => {
    for (let i = 0; i < 60; i++) {
      const r = await burnFn({ data: { txHash: burnTx.trim(), tokenId: burnToken.trim() } });
      if (r.status === "credited") {
        toast.success("Burn verified — free spin added!");
        setBurnTx(""); setBurnToken("");
        refresh();
        return;
      }
      await new Promise((res) => setTimeout(res, 2500)); // not mined yet
    }
    throw new Error("Still waiting for ApeChain to confirm that transaction. Try Verify again in a minute.");
  });

  if (!data) return <main className="mx-auto max-w-6xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>;
  const total = data.ledger.reduce((s, l) => s + l.amount, 0);
  const minLevel = data.nft.burn_min_level ?? 4;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Campaign points" value={total.toLocaleString()} />
        <Stat
          label="Spins available"
          value={String(data.credits.real)}
          accent
          {...(data.credits.demo > 0
            ? { sub: `+ ${data.credits.demo} free practice spin${data.credits.demo === 1 ? "" : "s"} (no prizes)` }
            : {})}
        />
        <Stat label="NFTs synced" value={String(data.holdings.filter((h) => !h.burned).length)} />
      </div>

      {/* IRL prizes waiting to be claimed */}
      <div className="mt-6">
        <SafeSection label="IRL prizes">
          <IrlPrizes />
        </SafeSection>
      </div>

      {/* Gotcha machine */}
      <div className="mt-6">
        <SafeSection label="gotcha machine">
          {user && <PlayerGotchaMachine userId={user.id} footnote="Buy more spins with Refill, or burn a Level 4+ NFT for a free one." />}
        </SafeSection>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Wallet & NFTs */}
        <section className="contents">
          <div className="rounded border border-border bg-card p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-bold">Wallets</h2>
              <Button size="sm" variant="outline" onClick={addWallet} disabled={!!busy}>{busy === "wallet" ? "Waiting…" : "Add wallet"}</Button>
            </div>
            {data.wallets.length ? (
              <ul className="mt-3 space-y-2 text-sm">
                {(data.wallets as WalletRow[]).map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
                    <span className="min-w-0 break-all font-mono text-xs">{w.address}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {w.kind === "privy" && <span className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] uppercase text-muted-foreground">Privy wallet</span>}
                      {w.is_default ? (
                        <span className="rounded bg-primary px-2 py-0.5 font-mono text-[11px] uppercase text-primary-foreground">Default</span>
                      ) : (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => makeDefault(w.address)}>
                          {busy === `default:${w.address}` ? "Saving…" : "Make default"}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-muted-foreground">Add your ApeChain wallet to earn holding points.</p>}
            <p className="mt-3 text-xs text-muted-foreground">Your default wallet is used to pay for spins. Wallets you add also count for NFT holding points.</p>
          </div>

          <div className="rounded border border-border bg-card p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-bold">My ApeGames NFTs</h2>
              <Button size="sm" onClick={doSync} disabled={!data.wallets.length || !!busy}>{busy === "sync" ? "Syncing…" : "Sync NFTs"}</Button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {data.holdings.map((h) => {
                const lvl = h.level_override ?? h.level;
                const canBurn = !h.burned && lvl != null && lvl >= minLevel;
                return (
                  <div key={h.token_id}
                    className={`flex flex-col gap-1 rounded border p-2 text-left font-mono text-xs ${h.burned ? "opacity-40" : ""} ${burnToken === h.token_id ? "border-primary" : "border-border"}`}>
                    <div>#{h.token_id}</div>
                    <div className={canBurn ? "text-primary" : "text-muted-foreground"}>{h.burned ? "Burned" : `Lv ${lvl ?? "?"}`}</div>
                    {canBurn && (
                      <Button size="sm" className="mt-1 h-auto min-h-9 px-2 py-1 text-xs"
                        onClick={() => openBurn({ tokenId: h.token_id, owner: h.owner_address, level: lvl })}>
                        Burn → 1 spin
                      </Button>
                    )}
                  </div>
                );
              })}
              {!data.holdings.length && <p className="col-span-full text-sm text-muted-foreground">No NFTs synced yet.</p>}
            </div>
          </div>

          <div className="rounded border border-accent/60 bg-card p-4 sm:p-6">
            <h2 className="text-xl font-bold">Burn for a free spin</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Level {minLevel}+ only, and permanent. Tap <b>Burn → 1 spin</b> on an eligible NFT above: your wallet sends it to the burn address and the free spin is added as soon as ApeChain confirms.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              Already sent one to <span className="break-all font-mono">{data.nft.burn_address}</span> yourself? Paste the token ID and transaction hash:
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-[110px_1fr_auto]">
              <Input placeholder="Token ID" value={burnToken} onChange={(e) => setBurnToken(e.target.value)} />
              <Input placeholder="0x… transaction hash" value={burnTx} onChange={(e) => setBurnTx(e.target.value)} />
              <Button variant="secondary" onClick={doBurn} disabled={!burnTx || !burnToken || !!busy}>{busy === "burn" ? "Verifying…" : "Verify"}</Button>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <History title="Recent spins" rows={data.spins.filter((s) => s.status !== "refunded").map((s) => (s.status === "pending" ? { k: s.id, l: "Drawing on-chain…", r: "Chainlink VRF", c: "text-muted-foreground" } : { k: s.id, l: s.prize_name ?? "Prize", r: `+${s.points ?? 0}`, c: s.rarity ? rarityClass[s.rarity]?.split(" ")[0] : undefined }))} />
        <History title="Points history" rows={data.ledger.slice(0, 20).map((l) => ({ k: String(l.id), l: `${l.reason}${l.ref && l.reason === "holding" ? ` #${l.ref}` : ""}`, r: `${l.amount > 0 ? "+" : ""}${l.amount}` }))} />
      </div>
    </main>
  );
}

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: boolean; sub?: string }) {
  return (
    <div className="min-w-0 rounded border border-border bg-card p-4 sm:p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 break-all font-display text-3xl font-bold sm:text-4xl ${accent ? "text-primary" : ""}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function History({ title, rows }: { title: string; rows: { k: string; l: string; r: string; c?: string | undefined }[] }) {
  return (
    <div className="rounded border border-border bg-card p-4 sm:p-6">
      <h3 className="text-lg font-bold">{title}</h3>
      <ul className="mt-3 divide-y divide-border font-mono text-sm">
        {rows.map((r) => <li key={r.k} className="flex justify-between gap-3 py-2 text-left"><span className={r.c}>{r.l}</span><span className="max-w-[60%] break-all text-right">{r.r}</span></li>)}
        {!rows.length && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
      </ul>
    </div>
  );
}
