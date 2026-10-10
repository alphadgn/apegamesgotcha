import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { checkDraw, getMachineReadiness, startDraw } from "@/lib/app.functions";
import { getShareSettings, submitShare } from "@/lib/season.functions";
import { openRefill } from "@/components/wallet/walletUi";
import { readPendingPurchase, usePurchaseConfirmer } from "@/components/wallet/CheckoutPanel";
import { GotchaMachine, type GotchaPrize } from "./GotchaMachine";
import { DemoGotchaMachine } from "./DemoGotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";

type MachineData = {
  credits: number;
  /** Practice spins an administrator granted: playable right away on the demo machine. */
  demoGrants: number;
  dbPrizes: GotchaPrize[];
  pendingIds: string[];
  lastFive: ShareSpin[]; // oldest → newest, fulfilled spins only
};

/** The real machine for a signed-in player: their own spin credits, Refill (buy with APE) and Share. */
export function PlayerGotchaMachine({ userId, footnote }: { userId: string; footnote?: string }) {
  const qc = useQueryClient();
  const drawFn = useServerFn(startDraw);
  const checkFn = useServerFn(checkDraw);
  const readinessFn = useServerFn(getMachineReadiness);
  const shareSettingsFn = useServerFn(getShareSettings);
  const submitShareFn = useServerFn(submitShare);
  const [inPlay, setInPlay] = useState(false);
  const [freeInPlay, setFreeInPlay] = useState(false);

  const { data } = useQuery({
    queryKey: ["machine", userId],
    queryFn: async (): Promise<MachineData> => {
      // Untyped: the generated database types can lag behind applied migrations.
      const db = supabase as unknown as SupabaseClient;
      const [credits, demoGrants, prizes, pending, recent] = await Promise.all([
        db
          .from("spin_credits")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("kind", "real")
          .is("used_spin_id", null),
        db
          .from("spin_credits")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("kind", "demo")
          .is("used_spin_id", null)
          .is("used_at", null),
        db
          .from("prizes")
          .select("id, name, rarity, weight, inventory")
          .eq("active", true)
          .order("created_at"),
        db.from("spins").select("id").eq("user_id", userId).eq("status", "pending"),
        db
          .from("spins")
          .select("id, prize_name, rarity, points, participation_points, bonus_points")
          .eq("user_id", userId)
          .eq("status", "fulfilled")
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      const err =
        credits.error ?? demoGrants.error ?? prizes.error ?? pending.error ?? recent.error;
      if (err) throw new Error(err.message);
      return {
        credits: credits.count ?? 0,
        demoGrants: demoGrants.count ?? 0,
        dbPrizes: ((prizes.data ?? []) as Omit<GotchaPrize, "points">[]).map((p) => ({
          ...p,
          points: 0,
        })),
        pendingIds: ((pending.data ?? []) as { id: string }[]).map((s) => s.id),
        lastFive: ((recent.data ?? []) as ShareSpin[]).filter((s) => s.prize_name).reverse(),
      };
    },
    // Spins an administrator grants show up within seconds, without a reload.
    // Grants show up within seconds without a reload: every 5s while the player has nothing to spin.
    refetchInterval: (q) =>
      inPlay || freeInPlay
        ? false
        : (q.state.data?.credits ?? 0) + (q.state.data?.demoGrants ?? 0) === 0
          ? 5_000
          : 15_000,
    refetchOnWindowFocus: true,
  });

  // Narrow, authenticated readiness + published odds (players can't read the draw configuration itself).
  const readiness = useQuery({
    queryKey: ["machine-readiness", userId],
    queryFn: () => readinessFn(),
    staleTime: 30_000,
  });
  const shareSettings = useQuery({
    queryKey: ["share-settings", userId],
    queryFn: () => shareSettingsFn(),
    staleTime: 60_000,
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

  const r = readiness.data;
  const closedReason = readiness.error
    ? "Couldn't check whether the draw is open. Your spins are saved — try again in a moment."
    : r && !r.open
      ? (r.reason ?? "The on-chain prize draw isn't open right now. Your spins are saved.")
      : undefined;
  // Prize list with the season points each prize would earn (participation + bonus), from the published pool.
  const participation = Number(r?.season?.participation_points ?? 0);
  const prizes: GotchaPrize[] = r?.odds?.length
    ? r.odds.map((o) => ({
        id: o.prize_id,
        name: o.name,
        rarity: o.rarity,
        points: r.season ? participation + Number(o.bonus ?? 0) : 0,
        weight: Math.round(Number(o.probability) * 1_000_000),
        inventory: o.remaining,
      }))
    : (data?.dbPrizes ?? []);

  const credits = data?.credits ?? 0;
  const showShare = credits === 0 && !inPlay && (data?.lastFive.length ?? 0) > 0;
  const earn = shareSettings.data?.enabled
    ? {
        points: shareSettings.data.points,
        submit: async (spinId: string, postUrl: string) => {
          if (!shareSettings.data?.xAccount)
            return "Link your X handle on your profile page first.";
          const res = await submitShareFn({ data: { spinId, postUrl } });
          return res.status === "approved"
            ? `Verified — +${shareSettings.data.points} points!`
            : res.status === "limit_reached"
              ? "Verified, but you've already earned today's share points."
              : "Submitted. Points are added once the post is verified.";
        },
      }
    : undefined;

  // Spins the player can use, in order: real spins (draw open) → granted demo spins (right away) →
  // the free practice spin every 30 minutes (only once the others are used up). While the draw is
  // closed, real spins stay saved and granted demo spins remain playable; the countdown never blocks them.
  const drawClosed = !!closedReason;
  const idle = !inPlay && (data?.pendingIds.length ?? 0) === 0;
  const demoFirst = !!data && idle && (credits === 0 || (drawClosed && data.demoGrants > 0));
  if (data && (demoFirst || freeInPlay)) {
    return (
      <DemoGotchaMachine
        prizes={prizes}
        userId={userId}
        grantedSpins={data.demoGrants}
        savedRealSpins={credits}
        onBusyChange={(busy) => {
          setFreeInPlay(busy);
          if (!busy) void refresh();
        }}
      />
    );
  }

  const limits = r
    ? ` · ${r.daily_used}/${r.daily_limit} today${r.season ? ` · ${r.season_used}/${r.season_limit} this season` : ""}`
    : "";
  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>
          {credits > 0
            ? `${credits} spin${credits === 1 ? "" : "s"} ready`
            : "Out of spins — refill to keep playing"}{" "}
          · drawn on-chain by Chainlink VRF{limits}
        </span>
        <span className="gm-bar-actions">
          {showShare && <ShareSpinsButton spins={data?.lastFive ?? []} earn={earn} />}
          <button type="button" className="gm-refill-btn" onClick={() => openRefill()}>
            Refill spins
          </button>
        </span>
      </div>
      <GotchaMachine
        credits={credits}
        prizes={prizes}
        onDraw={(count) =>
          drawFn({ data: { count, idempotencyKey: crypto.randomUUID().replace(/-/g, "") } }).then(
            (x) => ({ spinIds: x.spinIds, txUrl: x.txUrl }),
          )
        }
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
