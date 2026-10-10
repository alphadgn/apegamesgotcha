import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { checkDraw, getDrawStatus, getMySpinBalance, startDraw } from "@/lib/app.functions";
import { openRefill } from "@/components/wallet/walletUi";
import { readPendingPurchase, usePurchaseConfirmer } from "@/components/wallet/CheckoutPanel";
import { GotchaMachine, type GotchaPrize } from "./GotchaMachine";
import { DemoGotchaMachine } from "./DemoGotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";

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

/** The real machine for a signed-in player: their own spin credits, Refill (buy with APE) and Share. */
export function PlayerGotchaMachine({ userId, footnote }: { userId: string; footnote?: string }) {
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
        db.from("prizes").select("id, name, rarity, points, weight, inventory").eq("active", true).order("created_at"),
        db.from("spins").select("id").eq("user_id", userId).eq("status", "pending"),
        db.from("spins").select("prize_name, rarity, points").eq("user_id", userId).eq("status", "fulfilled").order("created_at", { ascending: false }).limit(5),
      ]);
      return {
        credits: balance.real,
        demoGrants: balance.demo,
        nextFreeAt: balance.nextFreeAt,
        prizes: (prizes.data ?? []) as GotchaPrize[],
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
  const { data: vrfOpen } = useQuery({
    queryKey: ["vrf-open"],
    queryFn: async () => (await drawStatusFn()).open,
    staleTime: 30_000,
  });
  const closedReason = vrfOpen === false ? "The on-chain prize draw is being switched on. Your spins are saved." : undefined;

  const credits = data?.credits ?? 0;
  const showShare = credits === 0 && !inPlay && (data?.lastFive.length ?? 0) > 0;

  // Which spins the player can use right now, in this order:
  //   1. real spins (purchased or granted paid-equivalent) — when the on-chain draw is open
  //   2. demo spins the team granted — straight away, no countdown
  //   3. the free practice spin every 30 minutes — only once 1 and 2 are used up
  // So the countdown never stands in front of spins the player holds. While the on-chain draw is closed,
  // real spins stay saved and granted demo spins are still playable.
  const drawClosed = vrfOpen === false;
  const idle = !inPlay && (data?.pendingIds.length ?? 0) === 0;
  const demoFirst = !!data && idle && (credits === 0 || (drawClosed && data.demoGrants > 0));
  if (data && (demoFirst || freeInPlay)) {
    return (
      <DemoGotchaMachine
        prizes={data.prizes}
        userId={userId}
        grantedSpins={data.demoGrants}
        savedRealSpins={credits}
        nextFreeAt={data.nextFreeAt}
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
          <button type="button" className="gm-refill-btn" onClick={() => openRefill()}>
            Refill spins
          </button>
        </span>
      </div>
      <GotchaMachine
        credits={credits}
        prizes={data?.prizes ?? []}
        onDraw={(count) => drawFn({ data: { count } })}
        onCheck={(ids) => checkFn({ data: { ids } })}
        resumeIds={data?.pendingIds ?? []}
        onSessionEnd={refresh}
        onError={(m) => toast.error(m)}
        onNoSpins={() => openRefill()}
        onBusyChange={setInPlay}
        closedReason={closedReason}
        {...(footnote ? { footnote } : {})}
      />
    </div>
  );
}
