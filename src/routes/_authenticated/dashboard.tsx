import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getWalletNonce, linkWallet, syncNfts, claimBurn, spin } from "@/lib/app.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "My Machine — ApeGames Gotcha" },
      { name: "description", content: "Your wallet, NFTs, spins and points." },
      { property: "og:title", content: "My Machine — ApeGames Gotcha" },
      { property: "og:description", content: "Your wallet, NFTs, spins and points." },
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

function useMyData() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user!.id;
      const [wallets, holdings, ledger, credits, spins, nftCfg] = await Promise.all([
        supabase.from("wallets").select("*").eq("user_id", uid),
        supabase.from("nft_holdings").select("*").eq("user_id", uid).order("token_id"),
        supabase.from("points_ledger").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
        supabase.from("spin_credits").select("*").eq("user_id", uid).is("used_spin_id", null),
        supabase.from("spins").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
        supabase.from("app_config").select("value").eq("key", "nft").single(),
      ]);
      return {
        wallets: wallets.data ?? [],
        holdings: holdings.data ?? [],
        ledger: ledger.data ?? [],
        credits: credits.data ?? [],
        spins: spins.data ?? [],
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
  const syncFn = useServerFn(syncNfts);
  const burnFn = useServerFn(claimBurn);
  const spinFn = useServerFn(spin);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ prize_name: string; rarity: string; points: number } | null>(null);
  const [burnTx, setBurnTx] = useState("");
  const [burnToken, setBurnToken] = useState("");

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

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

  const doSpin = () => run("spin", async () => {
    setResult(null);
    const [r] = await Promise.all([spinFn(), new Promise((res) => setTimeout(res, 1400))]);
    setResult(r);
    refresh();
  });

  const doBurn = () => run("burn", async () => {
    await burnFn({ data: { txHash: burnTx.trim(), tokenId: burnToken.trim() } });
    toast.success("Burn verified — free spin added!");
    setBurnTx(""); setBurnToken("");
    refresh();
  });

  if (!data) return <main className="mx-auto max-w-6xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>;
  const total = data.ledger.reduce((s, l) => s + l.amount, 0);
  const minLevel = data.nft.burn_min_level ?? 4;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Campaign points" value={total.toLocaleString()} />
        <Stat label="Spins available" value={String(data.credits.length)} accent />
        <Stat label="NFTs synced" value={String(data.holdings.filter((h) => !h.burned).length)} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* Gacha machine */}
        <section className="rounded border-2 border-primary bg-card p-6 text-center">
          <h2 className="text-2xl font-bold">Gacha machine</h2>
          <div className="mx-auto my-8 flex h-44 w-44 items-center justify-center rounded-full border-4 border-border bg-background">
            {busy === "spin" ? (
              <div className="animate-capsule h-20 w-20 rounded-full bg-gradient-to-b from-accent to-primary" />
            ) : result ? (
              <div className={`rounded border-2 px-3 py-4 ${rarityClass[result.rarity] ?? ""}`}>
                <p className="font-mono text-xs uppercase">{result.rarity}</p>
                <p className="font-display text-lg font-bold">{result.prize_name}</p>
                <p className="font-mono text-sm">+{result.points} pts</p>
              </div>
            ) : (
              <div className="h-20 w-20 rounded-full bg-gradient-to-b from-accent to-primary opacity-70" />
            )}
          </div>
          <Button size="lg" className="w-full" disabled={!data.credits.length || !!busy} onClick={doSpin}>
            {data.credits.length ? `Spin (${data.credits.length} left)` : "No spins available"}
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">Paid spins open when checkout is enabled by the organizers.</p>
        </section>

        {/* Wallet & NFTs */}
        <section className="space-y-6">
          <div className="rounded border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Wallets</h2>
              <Button size="sm" variant="outline" onClick={connectWallet} disabled={!!busy}>{busy === "wallet" ? "Waiting…" : "Link wallet"}</Button>
            </div>
            {data.wallets.length ? (
              <ul className="mt-3 space-y-1 font-mono text-sm">{data.wallets.map((w) => <li key={w.id}>{w.address}</li>)}</ul>
            ) : <p className="mt-3 text-sm text-muted-foreground">Link your ApeChain wallet to earn holding points.</p>}
          </div>

          <div className="rounded border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">My ApeGames NFTs</h2>
              <Button size="sm" onClick={doSync} disabled={!data.wallets.length || !!busy}>{busy === "sync" ? "Syncing…" : "Sync NFTs"}</Button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {data.holdings.map((h) => {
                const lvl = h.level_override ?? h.level;
                return (
                  <button key={h.token_id} onClick={() => setBurnToken(h.token_id)} disabled={h.burned}
                    className={`rounded border p-2 text-left font-mono text-xs ${h.burned ? "opacity-40" : "hover:border-primary"} ${burnToken === h.token_id ? "border-primary" : "border-border"}`}>
                    <div>#{h.token_id}</div>
                    <div className={lvl != null && lvl >= minLevel ? "text-primary" : "text-muted-foreground"}>{h.burned ? "Burned" : `Lv ${lvl ?? "?"}`}</div>
                  </button>
                );
              })}
              {!data.holdings.length && <p className="col-span-full text-sm text-muted-foreground">No NFTs synced yet.</p>}
            </div>
          </div>

          <div className="rounded border border-accent/60 bg-card p-6">
            <h2 className="text-xl font-bold">Burn for a free spin</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Level {minLevel}+ only. Transfer the NFT from your linked wallet to <span className="break-all font-mono">{data.nft.burn_address}</span>, then paste the transaction hash. This is permanent.
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
        <History title="Recent spins" rows={data.spins.map((s) => ({ k: s.id, l: s.prize_name, r: `+${s.points}`, c: rarityClass[s.rarity]?.split(" ")[0] }))} />
        <History title="Points history" rows={data.ledger.slice(0, 20).map((l) => ({ k: String(l.id), l: `${l.reason}${l.ref && l.reason === "holding" ? ` #${l.ref}` : ""}`, r: `${l.amount > 0 ? "+" : ""}${l.amount}` }))} />
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded border border-border bg-card p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 font-display text-4xl font-bold ${accent ? "text-primary" : ""}`}>{value}</p>
    </div>
  );
}

function History({ title, rows }: { title: string; rows: { k: string; l: string; r: string; c?: string | undefined }[] }) {
  return (
    <div className="rounded border border-border bg-card p-6">
      <h3 className="text-lg font-bold">{title}</h3>
      <ul className="mt-3 divide-y divide-border font-mono text-sm">
        {rows.map((r) => <li key={r.k} className="flex justify-between py-2"><span className={r.c}>{r.l}</span><span>{r.r}</span></li>)}
        {!rows.length && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
      </ul>
    </div>
  );
}
