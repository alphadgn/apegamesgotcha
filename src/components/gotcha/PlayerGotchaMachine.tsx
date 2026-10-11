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
        prizes: ((prizes.data ?? []) as GotchaPrize[]).map((p) => ({
          id: p.id,
          name: p.name,
          rarity: p.rarity,
          points: p.points,
          ...(p.weight != null ? { weight: p.weight } : {}),
          inventory: p.inventory ?? null,
          image_url: p.image_url ?? null,
          is_physical: !!p.is_physical,
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
        }}
        onReveal={(r) => {
          const win = winFor(r);
          if (win && !toClaim.current.some((w) => w.spin_id === win.spin_id)) toClaim.current.push(win);
        }}
        revealAction={(r) => {
          const win = winFor(r);
          return win && !claimed(win.spin_id) ? (
            <button type="button" className="gm-claim-btn" onClick={() => setClaimWin(win)}>
              🎁 Claim your IRL prize
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
              your address. You can also claim it later from Your IRL prizes on My Machine.
            </DialogDescription>
          </DialogHeader>
          {claimWin && <ClaimForm win={claimWin} onDone={closeClaim} cancelLabel="Later" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
