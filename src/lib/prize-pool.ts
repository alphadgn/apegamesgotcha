// Prize pool "critical low": when the prizes left fall to 20% of what was stocked, live (Chainlink) spins
// and spin purchases pause until an admin restocks. Shared by server and client.

/** Hold live buys & spins once remaining prizes are at or below this share of the stocked amount. */
export const RESTOCK_THRESHOLD = 0.2;

export const RESTOCK_MESSAGE = "Live buys & spins are on hold for restocking.";

export type PoolPrize = {
  inventory: number | null;
  stocked?: number | null;
  weight: number;
  active: boolean;
};

export type PoolStatus = {
  /** Prizes left across limited-stock prizes in the pool. */
  remaining: number;
  /** How many of those prizes were stocked (at each prize's last restock). */
  stocked: number;
  /** remaining / stocked (1 when nothing is limited). */
  ratio: number;
  onHold: boolean;
};

/**
 * Only active prizes that can be drawn and have a limited inventory count; unlimited prizes never run out.
 * A prize's stocked amount is its inventory at its last restock (never below what's left now).
 */
export function poolStatus(prizes: PoolPrize[]): PoolStatus {
  let remaining = 0;
  let stocked = 0;
  for (const p of prizes) {
    if (!p.active || p.weight <= 0 || p.inventory == null) continue;
    const left = Math.max(0, p.inventory);
    remaining += left;
    stocked += Math.max(p.stocked ?? left, left);
  }
  const ratio = stocked > 0 ? remaining / stocked : 1;
  return { remaining, stocked, ratio, onHold: stocked > 0 && ratio <= RESTOCK_THRESHOLD };
}
