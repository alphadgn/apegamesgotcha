import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { checkDraw, getDrawStatus, getMySpinBalance, startDraw } from "@/lib/app.functions";
import { openRefill } from "@/components/wallet/walletUi";
import { readPendingPurchase, usePurchaseConfirmer } from "@/components/wallet/CheckoutPanel";
import { GotchaMachine, type GotchaPrize, type GotchaResult, type PlayMode } from "./GotchaMachine";
import { useRefillGuide } from "./useRefillGuide";
import { DemoGotchaMachine } from "./DemoGotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";
import { ClaimForm, IRL_QUERY_KEY, useMyIrlPrizes } from "@/components/IrlPrizes";
import { CERT_QUERY_KEY, CertificateChoice, useMyCertificates } from "@/components/GiftCertificates";
import { STOCK_QUERY_KEY, StockChoice, useMyStockCertificates } from "@/components/StockCertificates";
import type { IrlWin } from "@/lib/claims.functions";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RESTOCK_MESSAGE } from "@/lib/prize-pool";

type MachineData = {
  credits: number;
  /** Practice spins an administrator granted: playable right away on the demo machine. */
  demoGrants: number;
  /** Server clock for the free demo spin (undefined until the demo board is set up). */
  nextFreeAt?: string | null | undefined;
  prizes: GotchaPrize[];
  pendingIds: string[];
  lastFive: ShareSpin[]; // oldest → newest
};

/**
 * The machine for a signed-in player. With DEMO / LIVE buttons (`onPlayModeChange` set) the player picks:
 * DEMO plays their demo spins (granted + the free one every 30 minutes), LIVE their real on-chain spins.
 * Without the buttons it picks for them (real spins first, then demo spins).
 */
export function PlayerGotchaMachine({
  userId,
  footnote,
  playMode,
  onPlayModeChange,
}: {
  userId: string;
  footnote?: string;
  playMode?: PlayMode | null | undefined;
  onPlayModeChange?: ((mode: PlayMode) => void) | undefined;
}) {
  const refill = useRefillGuide();
  const qc = useQueryClient();
  const drawFn = useServerFn(startDraw);
  const checkFn = useServerFn(checkDraw);
  const [inPlay, setInPlay] = useState(false);
  const [freeInPlay, setFreeInPlay] = useState(false);

  const balanceFn = useServerFn(getMySpinBalance);
  const { data } = useQuery({
    queryKey: ["machine", userId],
    queryFn: async (): Promise<MachineData> => {
      // Untyped: the generated database types can lag behind applied migrations.
      const db = supabase as unknown as SupabaseClient;
      const [balance, prizes, pending, recent] = await Promise.all([
        balanceFn(), // real + granted demo spins (works before and after the grant migration)
        db.from("prizes").select("*").eq("active", true).order("created_at"), // includes is_physical once added
        db.from("spins").select("id").eq("user_id", userId).eq("status", "pending"),
        db.from("spins").select("prize_name, rarity, points").eq("user_id", userId).eq("status", "fulfilled").order("created_at", { ascending: false }).limit(5),
      ]);
      return {
        credits: balance.real,
        demoGrants: balance.demo,
        nextFreeAt: balance.nextFreeAt,
        prizes: ((prizes.data ?? []) as (GotchaPrize & { stock_token_ids?: string[] | null })[]).map((p) => ({
          id: p.id,
          name: p.name,
          rarity: p.rarity,
          points: p.points,
          ...(p.weight != null ? { weight: p.weight } : {}),
          inventory: p.inventory ?? null,
          image_url: p.image_url ?? null,
          is_physical: !!p.is_physical,
          cert_value_usd: p.cert_value_usd ?? null,
          is_stock: Array.isArray(p.stock_token_ids) && p.stock_token_ids.length > 0,
        })),
        pendingIds: ((pending.data ?? []) as { id: string }[]).map((s) => s.id),
        lastFive: ((recent.data ?? []) as ShareSpin[]).filter((s) => s.prize_name).reverse(),
      };
    },
    // Spins an administrator grants show up within seconds, without a reload: check every 5s while the
    // player has nothing to spin (so the countdown gives way at once), every 15s otherwise.
    refetchInterval: (q) =>
      inPlay || freeInPlay ? false : (q.state.data?.credits ?? 0) + (q.state.data?.demoGrants ?? 0) === 0 ? 5_000 : 15_000,
    refetchOnWindowFocus: true,
  });

  const refresh = useCallback(() => qc.invalidateQueries(), [qc]);

  // A payment that was still confirming when the page closed gets finished here.
  const confirm = usePurchaseConfirmer();
  useEffect(() => {
    const pending = readPendingPurchase();
    if (!pending) return;
    let cancelled = false;
    void confirm(pending, () => cancelled).then((q) => {
      if (q && !cancelled) {
        toast.success(`${q} spins added to your machine`);
        void refresh();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [confirm, refresh]);

  // Real spins need the on-chain draw switched on (Admin → Configuration → vrf).
  const drawStatusFn = useServerFn(getDrawStatus);
  const { data: drawStatus } = useQuery({
    queryKey: ["vrf-open"],
    queryFn: () => drawStatusFn(),
    staleTime: 30_000,
    refetchInterval: 60_000, // pick up a restock (or a new hold) without a reload
  });
  const vrfOpen = drawStatus?.open;
  // Prize pool critically low: live spins wait for the restock (demo spins still work).
  const restocking = !!drawStatus?.restocking;
  const closedReason = restocking
    ? `${RESTOCK_MESSAGE} Your spins are saved.`
    : vrfOpen === false
      ? "The on-chain prize draw is being switched on. Your spins are saved."
      : undefined;

  // Real-world prizes won on-chain that still need the player's delivery details.
  const { data: irl } = useMyIrlPrizes();
  const unclaimed = (irl ?? []).filter((w) => !w.claim).length;

  // ---- Claim step: a real-world prize won in a live draw asks for delivery details straight away ----
  const [claimWin, setClaimWin] = useState<IrlWin | null>(null);
  /** Real-world prizes won this session that haven't been claimed yet (opened when the session ends). */
  const toClaim = useRef<IrlWin[]>([]);
  const winFor = useCallback(
    (r: GotchaResult): IrlWin | null => {
      const prize = data?.prizes.find((p) => (r.prize_id && p.id === r.prize_id) || p.name === r.prize_name);
      if (!prize?.is_physical) return null;
      return { spin_id: r.id, won_at: new Date().toISOString(), prize_id: prize.id, prize_name: r.prize_name, rarity: r.rarity, image_path: prize.image_url ?? null, claim: null };
    },
    [data?.prizes],
  );
  const claimed = useCallback(
    (spinId: string) => !!irl?.some((w) => w.spin_id === spinId && w.claim),
    [irl],
  );
  const closeClaim = () => {
    if (claimWin) toClaim.current = toClaim.current.filter((w) => w.spin_id !== claimWin.spin_id);
    setClaimWin(null);
    void qc.invalidateQueries({ queryKey: IRL_QUERY_KEY });
  };

  // ---- Gift certificates won in a live draw: the winner chooses in person or the value in APE ----
  const [certSpin, setCertSpin] = useState<string | null>(null);
  const toCert = useRef<string[]>([]);
  const isCert = useCallback(
    (r: GotchaResult) => {
      const prize = data?.prizes.find((p) => (r.prize_id && p.id === r.prize_id) || p.name === r.prize_name);
      return prize?.cert_value_usd != null && !prize?.is_physical;
    },
    [data?.prizes],
  );
  const { data: certs, refetch: refetchCerts } = useMyCertificates(!!certSpin);
  const openCert = certSpin ? certs?.find((c) => c.spinId === certSpin) : undefined;
  useEffect(() => {
    // The record is made when the win is first listed: look again until it's there.
    if (certSpin && certs && !openCert) {
      const t = window.setTimeout(() => void refetchCerts(), 1500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [certSpin, certs, openCert, refetchCerts]);
  const closeCert = () => {
    if (certSpin) toCert.current = toCert.current.filter((id) => id !== certSpin);
    setCertSpin(null);
    void qc.invalidateQueries({ queryKey: CERT_QUERY_KEY });
    // A stock certificate won in the same session asks next.
    if (!inPlay && toStock.current[0]) setStockSpin((open) => open ?? toStock.current[0]!);
  };

  // ---- Stock certificates won in a live draw: sent to a wallet, or an email claim link ----
  const [stockSpin, setStockSpin] = useState<string | null>(null);
  const toStock = useRef<string[]>([]);
  const isStock = useCallback(
    (r: GotchaResult) => {
      const prize = data?.prizes.find((p) => (r.prize_id && p.id === r.prize_id) || p.name === r.prize_name);
      return !!prize?.is_stock && !prize?.is_physical;
    },
    [data?.prizes],
  );
  const { data: stocks, refetch: refetchStocks } = useMyStockCertificates(!!stockSpin);
  const openStock = stockSpin ? stocks?.rows.find((c) => c.spinId === stockSpin) : undefined;
  useEffect(() => {
    if (stockSpin && stocks && !openStock) {
      const t = window.setTimeout(() => void refetchStocks(), 1500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [stockSpin, stocks, openStock, refetchStocks]);
  const closeStock = () => {
    if (stockSpin) toStock.current = toStock.current.filter((id) => id !== stockSpin);
    setStockSpin(null);
    void qc.invalidateQueries({ queryKey: STOCK_QUERY_KEY });
  };

  const credits = data?.credits ?? 0;
  const showShare = credits === 0 && !inPlay && (data?.lastFive.length ?? 0) > 0;

  // Which spins the player can use right now, in this order:
  //   1. real spins (purchased or granted paid-equivalent) — when the on-chain draw is open
  //   2. demo spins the team granted — straight away, no countdown
  //   3. the free practice spin every 30 minutes — only once 1 and 2 are used up
  // So the countdown never stands in front of spins the player holds. While the on-chain draw is closed,
  // real spins stay saved and granted demo spins are still playable.
  const drawClosed = vrfOpen === false || restocking;
  const idle = !inPlay && (data?.pendingIds.length ?? 0) === 0;
  const picks = !!onPlayModeChange;
  const demoFirst = picks
    ? playMode === "demo"
    : !!data && idle && (credits === 0 || (drawClosed && data.demoGrants > 0));
  if (data && (demoFirst || freeInPlay)) {
    return (
      <DemoGotchaMachine
        prizes={data.prizes}
        userId={userId}
        grantedSpins={data.demoGrants}
        savedRealSpins={picks ? 0 : credits}
        nextFreeAt={data.nextFreeAt}
        playMode={playMode}
        onPlayModeChange={onPlayModeChange}
        onBusyChange={(busy) => {
          setFreeInPlay(busy);
          if (!busy) void refresh(); // session over: re-check which spins the player has left
        }}
      />
    );
  }

  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>
          {credits > 0 ? `${credits} spin${credits === 1 ? "" : "s"} ready` : "Out of spins — refill to keep playing"} · drawn on-chain by Chainlink VRF
        </span>
        <span className="gm-bar-actions">
          {showShare && <ShareSpinsButton spins={data?.lastFive ?? []} />}
          <button
            ref={refill.ref}
            type="button"
            className={`gm-refill-btn${refill.attention ? " is-refill-attention" : ""}`}
            onClick={() => {
              refill.clear();
              openRefill();
            }}
          >
            Refill spins
          </button>
        </span>
      </div>
      {unclaimed > 0 && !inPlay && (
        <a href="#irl" className="mb-2 block rounded border border-primary bg-primary/15 px-3 py-2 text-center text-sm font-bold text-primary">
          🎁 You won {unclaimed === 1 ? "an IRL prize" : `${unclaimed} IRL prizes`} — claim {unclaimed === 1 ? "it" : "them"} now
        </a>
      )}
      <GotchaMachine
        credits={credits}
        prizes={data?.prizes ?? []}
        onDraw={(count) => drawFn({ data: { count } })}
        onCheck={(ids) => checkFn({ data: { ids } })}
        pollMs={3000} // each check reads the chain: gentle on the network while Chainlink draws
        resumeIds={data?.pendingIds ?? []}
        onSessionEnd={refresh}
        onError={(m) => toast.error(m)}
        onNoSpins={picks ? refill.guide : () => openRefill()}
        playMode={playMode}
        onPlayModeChange={onPlayModeChange}
        onBusyChange={(busy) => {
          setInPlay(busy);
          // Session over: open the claim form for a real-world prize won in it (unless already claimed).
          const next = !busy ? toClaim.current.find((w) => !claimed(w.spin_id)) : undefined;
          if (next) setClaimWin((open) => open ?? next);
          // …and the choice for a gift certificate won in it.
          else if (!busy && toCert.current[0]) setCertSpin((open) => open ?? toCert.current[0]!);
          // …and how to receive a stock certificate won in it.
          else if (!busy && toStock.current[0]) setStockSpin((open) => open ?? toStock.current[0]!);
        }}
        onReveal={(r) => {
          const win = winFor(r);
          if (win && !toClaim.current.some((w) => w.spin_id === win.spin_id)) toClaim.current.push(win);
          if (isCert(r) && !toCert.current.includes(r.id)) toCert.current.push(r.id);
          if (isStock(r) && !toStock.current.includes(r.id)) toStock.current.push(r.id);
        }}
        revealAction={(r) => {
          const win = winFor(r);
          if (win && !claimed(win.spin_id))
            return (
              <button type="button" className="gm-claim-btn" onClick={() => setClaimWin(win)}>
                🎁 Claim your IRL prize
              </button>
            );
          if (isStock(r))
            return (
              <button type="button" className="gm-claim-btn" onClick={() => setStockSpin(r.id)}>
                📈 Claim your stock certificate
              </button>
            );
          return isCert(r) ? (
            <button type="button" className="gm-claim-btn" onClick={() => setCertSpin(r.id)}>
              🎟️ Use your gift certificate
            </button>
          ) : null;
        }}
        closedReason={closedReason}
        {...(footnote ? { footnote } : {})}
      />
      <Dialog open={!!claimWin} onOpenChange={(open) => !open && closeClaim()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>🎉 You won {claimWin?.prize_name}!</DialogTitle>
            <DialogDescription>
              It's a real-world prize. Tell us how you'd like to receive it: pick it up at ApeFest Charleston or have it shipped to
              your address (you pay the shipping, priced live for your address). You can also claim it later from Your IRL prizes on My Machine.
            </DialogDescription>
          </DialogHeader>
          {claimWin && <ClaimForm win={claimWin} onDone={closeClaim} cancelLabel="Later" />}
        </DialogContent>
      </Dialog>
      <Dialog open={!!certSpin && !claimWin} onOpenChange={(open) => !open && closeCert()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>🎟️ You won a gift certificate{openCert ? `: ${openCert.prize}` : ""}!</DialogTitle>
            <DialogDescription>
              {openCert
                ? `Worth $${openCert.valueUsd} at ${openCert.vendor}. Redeem it in person, or claim the value in APE. You can also decide later in Your gift certificates on My Machine.`
                : "Getting your certificate ready…"}
            </DialogDescription>
          </DialogHeader>
          {openCert && <CertificateChoice cert={openCert} />}
          <button type="button" className="text-sm underline text-muted-foreground" onClick={closeCert}>
            Later
          </button>
        </DialogContent>
      </Dialog>
      <Dialog open={!!stockSpin && !claimWin && !certSpin} onOpenChange={(open) => !open && closeStock()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>📈 You won a stock certificate{openStock ? `: ${openStock.prize}` : ""}!</DialogTitle>
            <DialogDescription>
              {openStock
                ? `It's an NFT on ${openStock.chain} holding stock tokens in its own vault: whoever owns it controls them. Have it sent to your wallet now, or get a claim link by email. You can also decide later in Your stock certificates on My Machine.`
                : "Getting your certificate ready…"}
            </DialogDescription>
          </DialogHeader>
          {openStock && stocks && <StockChoice cert={openStock} wallets={stocks.wallets} email={stocks.email} />}
          <button type="button" className="text-sm underline text-muted-foreground" onClick={closeStock}>
            Later
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
