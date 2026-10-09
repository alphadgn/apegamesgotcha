// Season rules helpers shared by the server and the UI. Points are exact integers carried as strings.

export type SeasonRules = {
  schema: number;
  points: {
    nft_snapshot_per_token: string;
    participation_per_spin: string;
    rarity_bonus: Record<"common" | "rare" | "epic" | "legendary", string>;
    prize_bonus_overrides: Record<string, string>;
    x_share: string;
  };
  limits: { spins_rolling_24h: number; spins_per_season: number; x_shares_per_utc_day: number };
  eligible_credit_sources: string[];
  referrals_enabled: false;
  historical_backfill_enabled: boolean;
};

export type PoolPrize = {
  id: string;
  name: string;
  rarity: string;
  weight: number;
  inventory: number | null;
  active: boolean;
  onchain_index?: number | null;
};

/** The bonus a prize earns under the rules: explicit override (including "0") wins over the rarity default. */
export function prizeBonus(rules: SeasonRules, prize: Pick<PoolPrize, "id" | "rarity">): bigint {
  const o = rules.points.prize_bonus_overrides?.[prize.id];
  if (o != null) return BigInt(o);
  const r = rules.points.rarity_bonus[prize.rarity as keyof SeasonRules["points"]["rarity_bonus"]];
  return BigInt(r ?? "0");
}

/** Prizes the next draw can actually land on (active, weighted, in stock). */
export function availablePool(prizes: PoolPrize[]) {
  return prizes.filter(
    (p) =>
      p.active &&
      p.weight > 0 &&
      (p.inventory == null || p.inventory > 0) &&
      p.onchain_index !== null,
  );
}

/**
 * Expected points per spin from the CURRENT available pool. With the initial 600/280/100/20 pool and
 * default bonuses this is 78 bonus + 10 participation = 88 — but only while every prize is in stock.
 * Returns exact rationals as decimal strings with 2 places.
 */
export function projectPerSpin(rules: SeasonRules, prizes: PoolPrize[]) {
  const pool = availablePool(prizes);
  const totalW = pool.reduce((s, p) => s + BigInt(p.weight), 0n);
  const part = BigInt(rules.points.participation_per_spin);
  if (totalW === 0n)
    return {
      expectedBonus: "0.00",
      expectedTotal: "0.00",
      participation: part.toString(),
      odds: [] as { name: string; rarity: string; probability: number; bonus: string }[],
    };
  const num = pool.reduce((s, p) => s + BigInt(p.weight) * prizeBonus(rules, p), 0n); // bonus * W
  const fmt = (n: bigint, d: bigint) => {
    const cents = (n * 100n + d / 2n) / d;
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  };
  return {
    expectedBonus: fmt(num, totalW),
    expectedTotal: fmt(num + part * totalW, totalW),
    participation: part.toString(),
    odds: pool.map((p) => ({
      name: p.name,
      rarity: p.rarity,
      probability: Number((BigInt(p.weight) * 1_000_000n) / totalW) / 1_000_000,
      bonus: prizeBonus(rules, p).toString(),
    })),
  };
}

/** Thousands separators for an integer string (bigint-safe). */
export function formatPoints(v: string | number | bigint | null | undefined) {
  if (v == null) return "0";
  const s = typeof v === "string" ? v : v.toString();
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
