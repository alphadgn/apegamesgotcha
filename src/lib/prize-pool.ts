// Prize pool levels. Shared by server and client.
// - Players: when the limited-stock prizes are all gone (0% left), live (Chainlink) spins and spin purchases
//   pause and a "restocking" pop-up shows, until an admin restocks.
// - Admins only: a low-stock warning from 20% left, so they can restock before players are affected.

/** Admins see a low-stock warning once remaining prizes are at or below this share of the stocked amount. */
export const LOW_STOCK_WARNING = 0.2;

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
  /** Players: 0% left — live buys & spins on hold until restocked. */
  onHold: boolean;
  /** Admins only: 20% or less left — time to restock. */
  lowStock: boolean;
};

/**
 * Only active prizes that can be drawn and have a limited inventory count; unlimited prizes never run out.
 * A prize's stocked amount is its inventory at its last restock (never below what's left now).
 */
export function poolStatus(prizes: PoolPrize[]): PoolStatus {
  let remaining = 0;
  let stocked = 0;
  let limited = 0;
  for (const p of prizes) {
    if (!p.active || p.weight <= 0 || p.inventory == null) continue;
    limited++;
    const left = Math.max(0, p.inventory);
    remaining += left;
    stocked += Math.max(p.stocked ?? left, left);
  }
  const ratio = stocked > 0 ? remaining / stocked : limited ? 0 : 1;
  return {
    remaining,
    stocked,
    ratio,
    onHold: limited > 0 && remaining === 0,
    lowStock: limited > 0 && ratio <= LOW_STOCK_WARNING,
  };
}
