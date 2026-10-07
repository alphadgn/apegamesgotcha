import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { checkDraw, startDraw } from "@/lib/app.functions";
import { RefillDialog } from "@/components/wallet/RefillDialog";
import { readPendingPurchase, usePurchaseConfirmer } from "@/components/wallet/CheckoutPanel";
import { GotchaMachine, type GotchaPrize } from "./GotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";

type MachineData = {
  credits: number;
  prizes: GotchaPrize[];
  pendingIds: string[];
  lastFive: ShareSpin[]; // oldest → newest
};

/** The real machine for a signed-in player: their own spin credits, Refill (buy with APE) and Share. */
export function PlayerGotchaMachine({ userId, footnote }: { userId: string; footnote?: string }) {
  const qc = useQueryClient();
  const drawFn = useServerFn(startDraw);
  const checkFn = useServerFn(checkDraw);
  const [refillOpen, setRefillOpen] = useState(false);
  const [inPlay, setInPlay] = useState(false);

  const { data } = useQuery({
    queryKey: ["machine", userId],
    queryFn: async (): Promise<MachineData> => {
      // Untyped: the generated database types can lag behind applied migrations.
      const db = supabase as unknown as SupabaseClient;
      const [credits, prizes, pending, recent] = await Promise.all([
        db.from("spin_credits").select("id", { count: "exact", head: true }).eq("user_id", userId).is("used_spin_id", null),
        db.from("prizes").select("id, name, rarity, points, weight, inventory").eq("active", true).order("created_at"),
        db.from("spins").select("id").eq("user_id", userId).eq("status", "pending"),
        db.from("spins").select("prize_name, rarity, points").eq("user_id", userId).eq("status", "fulfilled").order("created_at", { ascending: false }).limit(5),
      ]);
      return {
        credits: credits.count ?? 0,
        prizes: (prizes.data ?? []) as GotchaPrize[],
        pendingIds: ((pending.data ?? []) as { id: string }[]).map((s) => s.id),
        lastFive: ((recent.data ?? []) as ShareSpin[]).filter((s) => s.prize_name).reverse(),
      };
    },
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
  const { data: vrfOpen } = useQuery({
    queryKey: ["vrf-open"],
    queryFn: async () => {
      const { data: row } = await supabase.from("app_config").select("value").eq("key", "vrf").maybeSingle();
      const v = (row?.value ?? {}) as { enabled?: boolean; contract?: string };
      return !!v.enabled && /^0x[0-9a-fA-F]{40}$/.test(v.contract ?? "");
    },
    staleTime: 60_000,
  });
  const closedReason = vrfOpen === false ? "The on-chain prize draw is being switched on. Your spins are saved." : undefined;

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
          <button type="button" className="gm-refill-btn" onClick={() => setRefillOpen(true)}>
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
        onNoSpins={() => setRefillOpen(true)}
        onBusyChange={setInPlay}
        closedReason={closedReason}
        {...(footnote ? { footnote } : {})}
      />
      <RefillDialog
        open={refillOpen}
        onClose={() => setRefillOpen(false)}
        signedIn
        onPurchased={(q) => {
          toast.success(`${q} spins added to your machine`);
          void refresh();
          window.setTimeout(() => setRefillOpen(false), 1600);
        }}
      />
    </div>
  );
}
