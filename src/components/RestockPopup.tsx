// Pop-up shown while the prize pool is critically low (20% or less left): live buys & spins pause until an
// admin restocks. Shown once per hold per browser session; it comes back if a new hold starts later.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPrizePoolStatus } from "@/lib/app.functions";
import { RESTOCK_MESSAGE } from "@/lib/prize-pool";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GOLD = "#f6c343";
const KEY = "gm-restock-popup-seen";

export function usePrizePoolStatus() {
  const fn = useServerFn(getPrizePoolStatus);
  return useQuery({
    queryKey: ["prize-pool-status"],
    queryFn: () => fn(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function RestockPopup() {
  const { data } = usePrizePoolStatus();
  const [open, setOpen] = useState(false);
  const onHold = !!data?.onHold;

  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded) return; // still loading: neither show nor reset "already seen"
    // Not on the page Glyph's sign-in tab lands on (it just hands the sign-in back and closes).
    if (new URLSearchParams(window.location.search).has("privy_oauth_code")) return;
    try {
      if (!onHold) {
        sessionStorage.removeItem(KEY); // restocked: a future hold shows the pop-up again
        setOpen(false);
        return;
      }
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* storage unavailable: still show it */
    }
    setOpen(true);
  }, [onHold, loaded]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm bg-card" style={{ borderColor: `${GOLD}66` }}>
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="mb-1 text-4xl" aria-hidden>
            📦
          </div>
          <DialogTitle className="text-2xl">Restocking prizes</DialogTitle>
          <DialogDescription className="text-base">{RESTOCK_MESSAGE}</DialogDescription>
        </DialogHeader>
        <p className="text-center text-sm text-muted-foreground">
          Your spins are saved, and demo spins still work. Live buying and spinning switch back on
          as soon as the prize pool is restocked.
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-12 w-full rounded-lg px-3 py-2 text-base font-bold transition hover:brightness-110"
          style={{ backgroundColor: GOLD, color: "#141414" }}
        >
          Got it
        </button>
      </DialogContent>
    </Dialog>
  );
}
