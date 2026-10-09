import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { setDefaultWallet } from "@/lib/app.functions";
import { claimBurn, claimSnapshot, getSnapshotStatus, syncNfts } from "@/lib/nft.functions";
import { getMyLedger, getMyStanding, getSeasons } from "@/lib/seasons.functions";
import { getMyShares, getShareSettings } from "@/lib/identity.functions";
import { requestLinkWallet } from "@/components/wallet/walletUi";
import { usePrivyPublicConfig } from "@/components/wallet/WalletHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerGotchaMachine } from "@/components/gotcha/PlayerGotchaMachine";
import { useAuth } from "@/hooks/useAuth";
import { SafeSection } from "@/components/SafeSection";
import { useLinkWalletWithSignature } from "@/components/season/useLinkWallet";
import { formatPoints } from "@/lib/seasonRules";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "My Machine — ApeGames Gotcha" },
      { name: "description", content: "Your season points, wallets, NFTs and spins." },
      { property: "og:title", content: "My Machine — ApeGames Gotcha" },
      { property: "og:description", content: "Your season points, wallets, NFTs and spins." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const rarityText: Record<string, string> = {
  common: "text-rarity-common",
  rare: "text-rarity-rare",
  epic: "text-rarity-epic",
  legendary: "text-rarity-legendary",
};
const subtypeLabel: Record<string, string> = {
  nft_snapshot: "Snapshot NFT",
  participation: "Spin",
  prize_bonus: "Prize bonus",
  x_share: "Verified share",
  adjustment: "Adjustment",
  legacy_holding: "Holding (legacy)",
  legacy_spin: "Prize (legacy)",
  legacy_adjustment: "Adjustment (legacy)",
  legacy_other: "Other (legacy)",
};

type WalletRow = { id: string; address: string; is_default?: boolean; kind?: string; verification_method?: string | null; is_contract?: boolean };
type SpinRow = { id: string; status: string; prize_name: string | null; rarity: string | null; participation_points: string | number | null; bonus_points: string | number | null; refund_reason: string | null; created_at: string };

function useMyData() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user!.id;
      const [wallets, holdings, credits, spins, fulfilledCount, nftCfg] = await Promise.all([
        supabase.from("wallets").select("*").eq("user_id", uid).order("verified_at"),
        supabase.from("nft_holdings").select("*").eq("user_id", uid).order("token_id"),
        supabase.from("spin_credits").select("id", { count: "exact", head: true }).eq("user_id", uid).is("used_spin_id", null),
        supabase.from("spins").select("id, status, prize_name, rarity, participation_points, bonus_points, refund_reason, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
        supabase.from("spins").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "fulfilled"),
        supabase.from("app_config").select("value").eq("key", "nft").maybeSingle(),
      ]);
      for (const r of [wallets, holdings, credits, spins, fulfilledCount, nftCfg]) if (r.error) throw new Error(r.error.message);
      return {
        wallets: (wallets.data ?? []) as WalletRow[],
        holdings: holdings.data ?? [],
        credits: credits.count ?? 0,
        spins: (spins.data ?? []) as unknown as SpinRow[],
        fulfilled: fulfilledCount.count ?? 0,
        nft: (nftCfg.data?.value ?? {}) as { burn_min_level?: number; burn_address?: string },
      };
    },
  });
}

function Dashboard() {
  const qc = useQueryClient();
  const { data, error } = useMyData();
  const refresh = () => qc.invalidateQueries();
  const seasonsFn = useServerFn(getSeasons);
  const standingFn = useServerFn(getMyStanding);
  const ledgerFn = useServerFn(getMyLedger);
  const snapFn = useServerFn(getSnapshotStatus);
  const claimFn = useServerFn(claimSnapshot);
  const sharesFn = useServerFn(getMyShares);
  const shareCfgFn = useServerFn(getShareSettings);
  const syncFn = useServerFn(syncNfts);
  const burnFn = useServerFn(claimBurn);
  const defaultFn = useServerFn(setDefaultWallet);
  const { data: privyCfg } = usePrivyPublicConfig();
  const linkWithSignature = useLinkWalletWithSignature();
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [burnTx, setBurnTx] = useState("");
  const [burnToken, setBurnToken] = useState("");

  const seasons = useQuery({ queryKey: ["seasons"], queryFn: () => seasonsFn() });
  const season = seasons.data?.find((s) => s.status === "active") ?? seasons.data?.find((s) => !s.is_legacy) ?? null;
  const standing = useQuery({ queryKey: ["my-standing", season?.slug, user?.id], queryFn: () => standingFn({ data: { slug: season!.slug } }), enabled: !!season });
  const ledger = useQuery({ queryKey: ["my-ledger", season?.slug], queryFn: () => ledgerFn({ data: { slug: season!.slug, limit: 50 } }), enabled: !!season });
  const snap = useQuery({ queryKey: ["snapshot-status"], queryFn: () => snapFn() });
  const shares = useQuery({ queryKey: ["my-shares"], queryFn: () => sharesFn() });
  const shareCfg = useQuery({ queryKey: ["share-settings"], queryFn: () => shareCfgFn() });

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <main className="mx-auto max-w-6xl px-4 py-12 text-destructive">Couldn't load your account: {(error as Error).message}</main>;
  if (!data) return <main className="mx-auto max-w-6xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>;
  const minLevel = data.nft.burn_min_level ?? 4;
  const st = standing.data;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <p className="font-mono text-xs uppercase text-muted-foreground">{season ? `${season.name}${season.ends_at ? ` · cutoff ${new Date(season.ends_at).toUTCString()}` : ""}` : "No active season"}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-4">
        <Stat label="Season points" value={formatPoints(st?.["total_points"] ?? "0")} accent />
        <Stat label="Season rank" value={st ? `#${st["rank"]}` : "—"} />
        <Stat label="Fulfilled spins" value={String(data.fulfilled)} />
        <Stat label="Spins available" value={String(data.credits)} />
      </div>
      {standing.error && <p className="mt-2 text-sm text-destructive">{(standing.error as Error).message}</p>}
      {st && (
        <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-5">
          {[
            ["Snapshot NFTs", st["nft_points"]],
            ["Spins", st["participation_points"]],
            ["Prize bonuses", st["prize_points"]],
            ["Verified shares", st["social_points"]],
            ["Adjustments", st["adjustment_points"]],
          ].map(([k, v]) => (
            <div key={k} className="rounded border border-border bg-card px-3 py-2">
              <div className="text-muted-foreground">{k}</div>
              <div className="text-base font-semibold">{formatPoints(v)}</div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Points are nontransferable engagement scores with no guaranteed dollar, APE or $GAMES value. <Link to="/leaderboard" className="underline">Rules & leaderboard</Link>
      </p>

      <div className="mt-6">
        <SafeSection label="gotcha machine">
          {user && <PlayerGotchaMachine userId={user.id} footnote="Buy more spins with Refill, or burn a Level 4+ NFT for a free one." />}
        </SafeSection>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Wallets */}
        <div className="rounded border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-bold">Verified wallets</h2>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run("wallet", async () => { await linkWithSignature(); toast.success("Wallet verified"); await refresh(); })}>
                {busy === "wallet" ? "Waiting…" : "Verify browser wallet"}
              </Button>
              {privyCfg?.privy_app_id && <Button size="sm" variant="ghost" onClick={() => requestLinkWallet()}>Add via Privy</Button>}
            </span>
          </div>
          {data.wallets.length ? (
            <ul className="mt-3 space-y-2 text-sm">
              {data.wallets.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-xs">{w.address}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {w.kind === "privy" && <Tag>Privy wallet</Tag>}
                    {w.is_contract && <Tag>Contract wallet</Tag>}
                    {w.verification_method && <Tag>{w.verification_method}</Tag>}
                    {w.is_default ? (
                      <span className="rounded bg-primary px-2 py-0.5 font-mono text-[10px] uppercase text-primary-foreground">Default</span>
                    ) : (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!!busy} onClick={() => run(`default:${w.address}`, async () => { await defaultFn({ data: { address: w.address } }); toast.success("Default wallet updated"); await refresh(); })}>
                        Make default
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Verify the wallet that held your 2025 NFTs to claim snapshot points.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Your default wallet pays for spins. Wallets can't be moved between accounts.</p>
        </div>

        {/* Snapshot claims */}
        <div className="rounded border border-border bg-card p-6">
          <h2 className="text-xl font-bold">2025 NFT snapshot</h2>
          {snap.error ? (
            <p className="mt-2 text-sm text-destructive">{(snap.error as Error).message}</p>
          ) : !snap.data ? (
            <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
          ) : snap.data.points_per_token === "0" || !snap.data.collections.length ? (
            <p className="mt-2 text-sm text-muted-foreground">Snapshot claims open once the 2025 collection and its snapshot block are confirmed for a season.</p>
          ) : (
            <ul className="mt-3 space-y-3 text-sm">
              {snap.data.collections.map((c) => (
                <li key={c.id as string} className="rounded border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{c.label as string} · block {String(c.snapshot_block)}</span>
                    <Button size="sm" disabled={!!busy || !data.wallets.length || c.status !== "ready"} onClick={() => run(`snap:${c.id}`, async () => { const r = await claimFn({ data: { collectionId: c.id as string } }); toast.success(`Found ${r.found} token(s); ${r.created} new claim(s)`); await refresh(); })}>
                      {busy === `snap:${c.id}` ? "Checking…" : "Check my snapshot NFTs"}
                    </Button>
                  </div>
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    {Object.entries(c.claims).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No claims yet"} · {snap.data.points_per_token} pts per verified token
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Ownership is checked on-chain at the snapshot block. Buying or receiving an NFT later doesn't count, and selling it later doesn't remove recognition.</p>
        </div>

        {/* Live NFTs + burn */}
        <div className="rounded border border-border bg-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">My ApeGames NFTs (live)</h2>
            <Button size="sm" onClick={() => run("sync", async () => { const r = await syncFn(); toast.success(`Found ${r.found} NFT(s)`); await refresh(); })} disabled={!data.wallets.length || !!busy}>
              {busy === "sync" ? "Syncing…" : "Sync NFTs"}
            </Button>
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
          <p className="mt-3 text-xs text-muted-foreground">Live holdings are for display and burns only — season points come from the frozen snapshot.</p>
        </div>

        <div className="rounded border border-accent/60 bg-card p-6">
          <h2 className="text-xl font-bold">Burn for a free spin</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Level {minLevel}+ only. Transfer the NFT from a verified wallet to <span className="break-all font-mono">{data.nft.burn_address}</span>, then paste the transaction hash
            once it's finalized. This is permanent, and free spins depend on the sponsored budget being open.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-[110px_1fr_auto]">
            <Input placeholder="Token ID" value={burnToken} onChange={(e) => setBurnToken(e.target.value)} />
            <Input placeholder="0x… transaction hash" value={burnTx} onChange={(e) => setBurnTx(e.target.value)} />
            <Button variant="secondary" disabled={!burnTx || !burnToken || !!busy} onClick={() => run("burn", async () => { await burnFn({ data: { txHash: burnTx.trim(), tokenId: burnToken.trim() } }); toast.success("Burn verified — free spin added!"); setBurnTx(""); setBurnToken(""); await refresh(); })}>
              {busy === "burn" ? "Verifying…" : "Verify"}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <History
          title="Recent spins"
          rows={data.spins.map((s) =>
            s.status === "pending"
              ? { k: s.id, l: "Drawing on-chain…", r: "Chainlink VRF", c: "text-muted-foreground" }
              : s.status === "refunded"
                ? { k: s.id, l: s.refund_reason === "no_prize" ? "No prize (credit returned)" : "Returned (draw didn't happen)", r: "+0", c: "text-muted-foreground" }
                : { k: s.id, l: s.prize_name ?? "Prize", r: `+${formatPoints(String(BigInt(s.participation_points ?? 0) + BigInt(s.bonus_points ?? 0)))}`, c: s.rarity ? rarityText[s.rarity] : undefined },
          )}
        />
        <History
          title={`Points ledger${season ? ` · ${season.name}` : ""}`}
          rows={(ledger.data ?? []).map((l) => ({
            k: String(l.id),
            l: `${subtypeLabel[String(l["reward_subtype"])] ?? String(l["reward_subtype"])}${l.reverses_id ? ` (reversal: ${String(l["reversal_reason"] ?? "")})` : ""}`,
            r: `${String(l.amount).startsWith("-") ? "" : "+"}${formatPoints(String(l.amount))}`,
          }))}
          error={ledger.error ? (ledger.error as Error).message : undefined}
        />
      </div>

      {(shareCfg.data?.enabled || (shares.data ?? []).length > 0) && (
        <div className="mt-8 rounded border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-bold">Verified X shares</h2>
            <Link to="/profile" className="text-sm underline">Link your X account</Link>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {shareCfg.data?.enabled ? `+${shareCfg.data.points} for a verified post of a result, at most ${shareCfg.data.perDay} per UTC day.` : "Share rewards are paused right now."}
          </p>
          <ul className="mt-3 divide-y divide-border font-mono text-xs">
            {(shares.data ?? []).map((s) => (
              <li key={s.id as string} className="flex flex-wrap justify-between gap-2 py-2">
                <a href={s.post_url as string} target="_blank" rel="noreferrer" className="underline">{String(s.post_url).replace("https://", "")}</a>
                <span>{String(s.status).replace("_", " ")}{s.decision_reason ? ` · ${s.decision_reason}` : ""}</span>
              </li>
            ))}
            {!shares.data?.length && <li className="py-2 text-muted-foreground">No shares submitted yet.</li>}
          </ul>
        </div>
      )}
    </main>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-muted px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">{children}</span>;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded border border-border bg-card p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 font-display text-4xl font-bold ${accent ? "text-primary" : ""}`}>{value}</p>
    </div>
  );
}

function History({ title, rows, error }: { title: string; rows: { k: string; l: string; r: string; c?: string | undefined }[]; error?: string | undefined }) {
  return (
    <div className="rounded border border-border bg-card p-6">
      <h3 className="text-lg font-bold">{title}</h3>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <ul className="mt-3 divide-y divide-border font-mono text-sm">
        {rows.map((r) => (
          <li key={r.k} className="flex justify-between gap-3 py-2">
            <span className={`text-left ${r.c ?? ""}`}>{r.l}</span>
            <span>{r.r}</span>
          </li>
        ))}
        {!rows.length && !error && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
      </ul>
    </div>
  );
}
