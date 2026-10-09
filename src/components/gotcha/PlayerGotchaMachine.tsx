import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { checkDraw, getMachineReadiness, startDraw } from "@/lib/draws.functions";
import { openRefill } from "@/components/wallet/walletUi";
import { readPendingPurchase, usePurchaseConfirmer } from "@/components/wallet/CheckoutPanel";
import { GotchaMachine, type GotchaPrize } from "./GotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";

type MachineData = {
  credits: number;
  pendingIds: string[];
  lastFive: ShareSpin[]; // oldest → newest
};

/** The real machine for a signed-in player: their own spin credits, Refill (buy with APE) and Share. */
export function PlayerGotchaMachine({ userId, footnote }: { userId: string; footnote?: string }) {
  const qc = useQueryClient();
  const drawFn = useServerFn(startDraw);
  const checkFn = useServerFn(checkDraw);
  const readyFn = useServerFn(getMachineReadiness);
  const [inPlay, setInPlay] = useState(false);
  // One idempotency key per pull; a retried request for the same pull reuses it.
  const pullKey = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ["machine", userId],
    queryFn: async (): Promise<MachineData> => {
      const db = supabase as unknown as SupabaseClient;
      const [credits, pending, recent] = await Promise.all([
        db.from("spin_credits").select("id", { count: "exact", head: true }).eq("user_id", userId).is("used_spin_id", null),
        db.from("spins").select("id").eq("user_id", userId).eq("status", "pending"),
        db.from("spins")
          .select("id, prize_name, rarity, participation_points, bonus_points")
          .eq("user_id", userId)
          .eq("status", "fulfilled")
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      for (const r of [credits, pending, recent]) if (r.error) throw new Error(r.error.message);
      type Row = { id: string; prize_name: string | null; rarity: string; participation_points: string | number | null; bonus_points: string | number | null };
      return {
        credits: credits.count ?? 0,
        pendingIds: ((pending.data ?? []) as { id: string }[]).map((s) => s.id),
        lastFive: ((recent.data ?? []) as Row[])
          .filter((s) => s.prize_name)
          .map((s) => ({
            id: s.id,
            prize_name: s.prize_name!,
            rarity: s.rarity,
            participation: String(s.participation_points ?? "0"),
            bonus: String(s.bonus_points ?? "0"),
            points: Number(BigInt(s.participation_points ?? 0) + BigInt(s.bonus_points ?? 0)),
          }))
          .reverse(),
      };
    },
  });

  // Narrow server readiness + published odds (ordinary players can't read the vrf config).
  const { data: ready } = useQuery({ queryKey: ["machine-readiness"], queryFn: () => readyFn(), staleTime: 30_000 });
  const prizes: GotchaPrize[] = (ready?.pool ?? []).map((p) => ({ id: p.id, name: p.name, rarity: p.rarity, weight: p.weight, inventory: p.inventory, points: Number(p.bonus) }));

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

  const closedReason = ready && !ready.open ? `${ready.reason ?? "Draws are paused."} Your spins are saved.` : undefined;

  const credits = data?.credits ?? 0;
  const showShare = credits === 0 && !inPlay && (data?.lastFive.length ?? 0) > 0;

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
        prizes={prizes}
        onDraw={async (count) => {
          pullKey.current ??= crypto.randomUUID();
          try {
            const out = await drawFn({ data: { count, idempotencyKey: pullKey.current } });
            pullKey.current = null;
            return out;
          } catch (e) {
            // A network failure may have reached the server: keep the key so a retry replays the same
            // reservation instead of creating a second one. Server-side refusals start fresh.
            if (!/fetch|network|timeout|load failed/i.test((e as Error).message)) pullKey.current = null;
            throw e;
          }
        }}
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
