import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  getWalletNonce,
  linkWallet,
  syncNfts,
  claimBurn,
  setDefaultWallet,
} from "@/lib/app.functions";
import { claimSnapshotPoints } from "@/lib/season.functions";
import { requestLinkWallet } from "@/components/wallet/walletUi";
import { usePrivyPublicConfig } from "@/components/wallet/WalletHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerGotchaMachine } from "@/components/gotcha/PlayerGotchaMachine";
import { useAuth } from "@/hooks/useAuth";
import { SafeSection } from "@/components/SafeSection";
import { defaultSeason, QueryError, useSeasons } from "@/components/season/SeasonBoard";
import { formatPoints } from "@/components/season/PublicIdentity";

// Untyped: the generated database types can lag behind applied migrations.
const db = supabase as unknown as SupabaseClient;

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "My Machine — ApeGames Gotcha" },
      { name: "description", content: "Your wallets, NFTs, spins and season points." },
      { property: "og:title", content: "My Machine — ApeGames Gotcha" },
      { property: "og:description", content: "Your wallets, NFTs, spins and season points." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const rarityClass: Record<string, string> = {
  common: "text-rarity-common",
  rare: "text-rarity-rare",
  epic: "text-rarity-epic",
  legendary: "text-rarity-legendary",
};

const SUBTYPE_LABEL: Record<string, string> = {
  nft_snapshot: "NFT snapshot",
  participation: "Spin",
  prize_bonus: "Prize bonus",
  social_share: "Verified X share",
  adjustment: "Adjustment",
  legacy: "Pre-season",
};

type WalletRow = {
  id: string;
  address: string;
  is_default?: boolean;
  kind?: string;
  verification?: string;
};
type ScoreRow = {
  nft_points: string;
  participation_points: string;
  prize_points: string;
  social_points: string;
  adjustment_points: string;
  legacy_points: string;
  total: string;
};
type LedgerRow = {
  id: number;
  amount: string;
  reward_subtype: string;
  source_id: string;
  reverses_id: number | null;
  reversal_reason: string | null;
  effective_at: string;
  metadata: Record<string, unknown>;
};

function useMyData(uid: string | undefined, seasonId: string | undefined) {
  return useQuery({
    queryKey: ["me", uid, seasonId],
    enabled: !!uid,
    queryFn: async () => {
      const [wallets, holdings, credits, spins, fulfilled, nftCfg, score, ledger, claims, shares] =
        await Promise.all([
          db
            .from("wallets")
            .select("id, address, is_default, kind, verification")
            .eq("user_id", uid),
          db
            .from("nft_holdings")
            .select("token_id, level, level_override, burned")
            .eq("user_id", uid)
            .order("token_id"),
          db
            .from("spin_credits")
            .select("id", { count: "exact", head: true })
            .eq("user_id", uid)
            .is("used_spin_id", null),
          db
            .from("spins")
            .select("id, status, prize_name, points, rarity, scored, score_note")
            .eq("user_id", uid)
            .in("status", ["pending", "fulfilled"])
            .order("created_at", { ascending: false })
            .limit(20),
          seasonId
            ? db
                .from("spins")
                .select("id", { count: "exact", head: true })
                .eq("user_id", uid)
                .eq("status", "fulfilled")
                .eq("season_id", seasonId)
            : db
                .from("spins")
                .select("id", { count: "exact", head: true })
                .eq("user_id", uid)
                .eq("status", "fulfilled"),
          db.from("app_config").select("value").eq("key", "nft").maybeSingle(),
          seasonId
            ? db
                .from("season_scores")
                .select(
                  "nft_points::text, participation_points::text, prize_points::text, social_points::text, adjustment_points::text, legacy_points::text, total::text",
                )
                .eq("user_id", uid)
                .eq("season_id", seasonId)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          seasonId
            ? db
                .from("points_ledger")
                .select(
                  "id, amount::text, reward_subtype, source_id, reverses_id, reversal_reason, effective_at, metadata",
                )
                .eq("user_id", uid)
                .eq("season_id", seasonId)
                .order("id", { ascending: false })
                .limit(50)
            : Promise.resolve({ data: [], error: null }),
          seasonId
            ? db
                .from("nft_snapshot_claims")
                .select("status")
                .eq("user_id", uid)
                .eq("season_id", seasonId)
            : Promise.resolve({ data: [], error: null }),
          db
            .from("social_shares")
            .select("id, status, post_id, submitted_at, award_day, rejection_reason")
            .eq("user_id", uid)
            .order("submitted_at", { ascending: false })
            .limit(10),
        ]);
      const err = [
        wallets,
        holdings,
        credits,
        spins,
        fulfilled,
        score,
        ledger,
        claims,
        shares,
      ].find((x) => x.error)?.error;
      if (err) throw new Error(err.message);
      const claimCounts: Record<string, number> = {};
      for (const c of (claims.data ?? []) as { status: string }[])
        claimCounts[c.status] = (claimCounts[c.status] ?? 0) + 1;
      return {
        wallets: (wallets.data ?? []) as WalletRow[],
        holdings: (holdings.data ?? []) as {
          token_id: string;
          level: number | null;
          level_override: number | null;
          burned: boolean;
        }[],
        credits: credits.count ?? 0,
        spins: (spins.data ?? []) as {
          id: string;
          status: string;
          prize_name: string | null;
          points: number | null;
          rarity: string | null;
          scored: boolean | null;
          score_note: string | null;
        }[],
        fulfilledCount: fulfilled.count ?? 0,
        nft: (nftCfg.data?.value ?? {}) as { burn_min_level?: number; burn_address?: string },
        score: (score.data ?? null) as ScoreRow | null,
        ledger: (ledger.data ?? []) as LedgerRow[],
        claimCounts,
        shares: (shares.data ?? []) as {
          id: string;
          status: string;
          post_id: string;
          submitted_at: string;
          rejection_reason: string | null;
        }[],
      };
    },
  });
}

function Dashboard() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const seasons = useSeasons();
  const [seasonId, setSeasonId] = useState<string | undefined>();
  useEffect(() => {
    if (!seasonId && seasons.data) setSeasonId(defaultSeason(seasons.data)?.id);
  }, [seasons.data, seasonId]);
  const season = seasons.data?.find((s) => s.id === seasonId);
  const me = useMyData(user?.id, seasonId);
  const data = me.data;
  const refresh = () => qc.invalidateQueries();
  const nonceFn = useServerFn(getWalletNonce);
  const linkFn = useServerFn(linkWallet);
  const defaultFn = useServerFn(setDefaultWallet);
  const { data: privyCfg } = usePrivyPublicConfig();
  const syncFn = useServerFn(syncNfts);
  const burnFn = useServerFn(claimBurn);
  const claimFn = useServerFn(claimSnapshotPoints);
  const [busy, setBusy] = useState<string | null>(null);
  const [burnTx, setBurnTx] = useState("");
  const [burnToken, setBurnToken] = useState("");

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

  // Add a wallet: through Privy (any wallet, incl. mobile) when it's set up, otherwise a browser-extension SIWE signature.
  const addWallet = () => (privyCfg?.privy_app_id ? requestLinkWallet() : connectWallet());

  const makeDefault = (address: string) =>
    run(`default:${address}`, async () => {
      await defaultFn({ data: { address } });
      toast.success("Default wallet updated");
      refresh();
    });

  const connectWallet = () =>
    run("wallet", async () => {
      const eth = (
        window as unknown as {
          ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
        }
      ).ethereum;
      if (!eth) throw new Error("No wallet found. Install MetaMask or another browser wallet.");
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!address) throw new Error("No account selected");
      const { message, nonce } = await nonceFn({ data: { address } });
      const signature = (await eth.request({
        method: "personal_sign",
        params: [message, address],
      })) as string;
      await linkFn({ data: { nonce, signature } });
      toast.success("Wallet linked");
      refresh();
    });

  const doSync = () =>
    run("sync", async () => {
      const r = await syncFn();
      toast.success(
        r.notEnumerable
          ? "This collection can't be listed automatically; burns still work by token ID."
          : `Found ${r.found} NFT(s) in your wallets`,
      );
      refresh();
    });

  const doBurn = () =>
    run("burn", async () => {
      await burnFn({ data: { txHash: burnTx.trim(), tokenId: burnToken.trim() } });
      toast.success("Burn verified — free spin added!");
      setBurnTx("");
      setBurnToken("");
      refresh();
    });

  const doClaim = () =>
    run("claim", async () => {
      if (!seasonId) return;
      const r = await claimFn({ data: { seasonId } });
      toast.success(
        `${r.verified} verified · ${r.unavailable} waiting on the archive node · ${r.rejected} not eligible`,
      );
      refresh();
    });

  if (me.error)
    return (
      <main className="mx-auto max-w-6xl px-4 py-12">
        <QueryError error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  if (!data)
    return (
      <main className="mx-auto max-w-6xl px-4 py-12 font-mono text-muted-foreground">Loading…</main>
    );
  const minLevel = data.nft.burn_min_level ?? 4;
  const snapshotOpen =
    season?.status === "active" && Number(season.rules["nft_snapshot_points"] ?? 0) > 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <label htmlFor="dash-season" className="text-sm text-muted-foreground">
          Season
        </label>
        <select
          id="dash-season"
          className="h-10 rounded border border-input bg-background px-3 text-sm"
          value={seasonId ?? ""}
          onChange={(e) => setSeasonId(e.target.value)}
        >
          {(seasons.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.is_legacy ? "" : ` (${s.status})`}
            </option>
          ))}
        </select>
        <Link to="/profile" className="inline-flex min-h-11 items-center text-sm text-primary underline">
          Public name & avatar
        </Link>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Stat
          label={season ? `${season.name} points` : "Season points"}
          value={formatPoints(data.score?.total)}
        />
        <Stat label="Spins available" value={String(data.credits)} accent />
        <Stat label="Fulfilled spins (this season)" value={String(data.fulfilledCount)} />
      </div>
      {data.score && <Breakdown score={data.score} legacy={!!season?.is_legacy} />}

      {/* Gotcha machine */}
      <div className="mt-6">
        <SafeSection label="gotcha machine">
          {user && (
            <PlayerGotchaMachine
              userId={user.id}
              footnote="Buy more spins with Refill, or burn a Level 4+ NFT for a free one."
            />
          )}
        </SafeSection>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded border border-border bg-card p-4 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold">Verified wallets</h2>
            <Button size="sm" variant="outline" onClick={addWallet} disabled={!!busy}>
              {busy === "wallet" ? "Waiting…" : "Add wallet"}
            </Button>
          </div>
          {data.wallets.length ? (
            <ul className="mt-3 space-y-2 text-sm">
              {data.wallets.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2"
                >
                  <span className="min-w-0 break-all font-mono text-xs">{w.address}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {w.kind === "privy" && (
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] uppercase text-muted-foreground">
                        Privy wallet
                      </span>
                    )}
                    {w.verification === "legacy_personal_sign" && (
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] uppercase text-muted-foreground">
                        Older signature
                      </span>
                    )}
                    {w.is_default ? (
                      <span className="rounded bg-primary px-2 py-0.5 font-mono text-[11px] uppercase text-primary-foreground">
                        Default
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={!!busy}
                        onClick={() => makeDefault(w.address)}
                      >
                        {busy === `default:${w.address}` ? "Saving…" : "Make default"}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Add your ApeChain wallet to claim snapshot points and burn NFTs.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Your default wallet pays for spins. A wallet can belong to only one account and is never
            moved between accounts.
          </p>
        </div>

        <div className="rounded border border-border bg-card p-4 sm:p-6">
          <h2 className="text-xl font-bold">NFT snapshot points</h2>
          {season?.is_legacy || !season ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Snapshot points are claimed during an active season.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Each 2025 ApeGames NFT owned by one of your verified wallets at this season's
                snapshot block earns {String(season.rules["nft_snapshot_points"] ?? 0)} points, once
                ever per NFT. Buying or selling after the snapshot doesn't change it.
              </p>
              <ul className="mt-3 flex flex-wrap justify-center gap-2 font-mono text-xs">
                {(["verified", "pending", "unavailable", "rejected"] as const).map((k) => (
                  <li key={k} className="rounded border border-border px-2 py-1">
                    {k}: {data.claimCounts[k] ?? 0}
                  </li>
                ))}
              </ul>
              {(data.claimCounts["unavailable"] ?? 0) > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  “Unavailable” claims are re-checked automatically when the archive node responds.
                </p>
              )}
              <Button
                className="mt-3"
                onClick={doClaim}
                disabled={!snapshotOpen || !data.wallets.length || !!busy}
              >
                {busy === "claim" ? "Checking the snapshot…" : "Claim snapshot points"}
              </Button>
            </>
          )}
        </div>

        <div className="rounded border border-border bg-card p-4 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold">My ApeGames NFTs (now)</h2>
            <Button size="sm" onClick={doSync} disabled={!data.wallets.length || !!busy}>
              {busy === "sync" ? "Syncing…" : "Sync NFTs"}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Shows what your wallets hold today, for burning. Points come only from the season
            snapshot.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {data.holdings.map((h) => {
              const lvl = h.level_override ?? h.level;
              return (
                <button
                  key={h.token_id}
                  onClick={() => setBurnToken(h.token_id)}
                  disabled={h.burned}
                  className={`rounded border p-2 text-left font-mono text-xs ${h.burned ? "opacity-40" : "hover:border-primary"} ${burnToken === h.token_id ? "border-primary" : "border-border"}`}
                >
                  <div>#{h.token_id}</div>
                  <div
                    className={
                      lvl != null && lvl >= minLevel ? "text-primary" : "text-muted-foreground"
                    }
                  >
                    {h.burned ? "Burned" : `Lv ${lvl ?? "?"}`}
                  </div>
                </button>
              );
            })}
            {!data.holdings.length && (
              <p className="col-span-full text-sm text-muted-foreground">No NFTs synced yet.</p>
            )}
          </div>
        </div>

        <div className="rounded border border-accent/60 bg-card p-4 sm:p-6">
          <h2 className="text-xl font-bold">Burn for a free spin</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Level {minLevel}+ only. Transfer the NFT from your linked wallet to{" "}
            <span className="break-all font-mono">{data.nft.burn_address}</span>, wait for it to
            finalize, then paste the transaction hash. This is permanent.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-[110px_1fr_auto]">
            <Input
              placeholder="Token ID"
              value={burnToken}
              onChange={(e) => setBurnToken(e.target.value)}
            />
            <Input
              placeholder="0x… transaction hash"
              value={burnTx}
              onChange={(e) => setBurnTx(e.target.value)}
            />
            <Button variant="secondary" onClick={doBurn} disabled={!burnTx || !burnToken || !!busy}>
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
              : {
                  k: s.id,
                  l: s.prize_name ?? "Prize",
                  r: s.scored ? `+${s.points ?? 0}` : "no season points",
                  c: s.rarity ? rarityClass[s.rarity] : undefined,
                },
          )}
        />
        <History
          title={`Points ledger${season ? ` · ${season.name}` : ""}`}
          rows={data.ledger.map((l) => ({
            k: String(l.id),
            l: `${SUBTYPE_LABEL[l.reward_subtype] ?? l.reward_subtype}${l.reverses_id ? ` · reversal (${l.reversal_reason ?? ""})` : ""}`,
            r: `${String(l.amount).startsWith("-") ? "" : "+"}${formatPoints(l.amount)}`,
          }))}
        />
      </div>
      {data.shares.length > 0 && (
        <div className="mt-6">
          <History
            title="X share submissions"
            rows={data.shares.map((s) => ({
              k: s.id,
              l: `Post ${s.post_id.slice(-6)}`,
              r:
                s.status === "limit_reached"
                  ? "verified · daily limit reached"
                  : s.status === "rejected"
                    ? `rejected${s.rejection_reason ? `: ${s.rejection_reason}` : ""}`
                    : s.status,
            }))}
          />
        </div>
      )}
    </main>
  );
}

function Breakdown({ score, legacy }: { score: ScoreRow; legacy: boolean }) {
  const parts = legacy
    ? [["Pre-season (archived)", score.legacy_points]]
    : [
        ["NFT snapshot", score.nft_points],
        ["Spins", score.participation_points],
        ["Prize bonuses", score.prize_points],
        ["Verified shares", score.social_points],
        ["Adjustments", score.adjustment_points],
      ];
  return (
    <ul className="mt-3 flex flex-wrap justify-center gap-2 font-mono text-xs">
      {parts.map(([k, v]) => (
        <li key={k} className="rounded border border-border bg-card px-3 py-1">
          {k}: {formatPoints(v)}
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded border border-border bg-card p-4 sm:p-5">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 break-all font-display text-3xl font-bold sm:text-4xl ${accent ? "text-primary" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function History({
  title,
  rows,
}: {
  title: string;
  rows: { k: string; l: string; r: string; c?: string | undefined }[];
}) {
  return (
    <div className="rounded border border-border bg-card p-4 sm:p-6">
      <h3 className="text-lg font-bold">{title}</h3>
      <ul className="mt-3 divide-y divide-border font-mono text-sm">
        {rows.map((r) => (
          <li key={r.k} className="flex justify-between gap-3 py-2 text-left">
            <span className={r.c}>{r.l}</span>
            <span className="max-w-[60%] break-all text-right">{r.r}</span>
          </li>
        ))}
        {!rows.length && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
      </ul>
    </div>
  );
}
