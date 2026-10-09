import { describe, expect, test } from "bun:test";
import { availablePool, formatPoints, prizeBonus, projectPerSpin, type PoolPrize, type SeasonRules } from "../../src/lib/seasonRules";

const rules: SeasonRules = {
  schema: 1,
  points: {
    nft_snapshot_per_token: "100",
    participation_per_spin: "10",
    rarity_bonus: { common: "25", rare: "100", epic: "250", legendary: "500" },
    prize_bonus_overrides: {},
    x_share: "2",
  },
  limits: { spins_rolling_24h: 10, spins_per_season: 100, x_shares_per_utc_day: 1 },
  eligible_credit_sources: ["purchase", "burn", "grant", "free"],
  referrals_enabled: false,
  historical_backfill_enabled: false,
};

const pool = (): PoolPrize[] => [
  { id: "c", name: "Common", rarity: "common", weight: 600, inventory: null, active: true, onchain_index: 0 },
  { id: "r", name: "Rare", rarity: "rare", weight: 280, inventory: null, active: true, onchain_index: 1 },
  { id: "e", name: "Epic", rarity: "epic", weight: 100, inventory: 5, active: true, onchain_index: 2 },
  { id: "l", name: "Legendary", rarity: "legendary", weight: 20, inventory: 1, active: true, onchain_index: 3 },
];

describe("projectPerSpin", () => {
  test("full initial pool: 78 bonus + 10 participation = 88", () => {
    const p = projectPerSpin(rules, pool());
    expect(p.expectedBonus).toBe("78.00");
    expect(p.expectedTotal).toBe("88.00");
    expect(p.odds.map((o) => o.probability)).toEqual([0.6, 0.28, 0.1, 0.02]);
  });

  test("projection follows the AVAILABLE pool, not the initial one", () => {
    const prizes = pool();
    prizes[3]!.inventory = 0; // legendary gone
    const p = projectPerSpin(rules, prizes);
    // (600*25 + 280*100 + 100*250) / 980 = 68000/980 = 69.387…
    expect(p.expectedBonus).toBe("69.39");
    expect(p.expectedTotal).toBe("79.39");
    expect(p.odds).toHaveLength(3);
  });

  test("empty pool projects nothing", () => {
    const p = projectPerSpin(rules, pool().map((x) => ({ ...x, active: false })));
    expect(p.expectedTotal).toBe("0.00");
    expect(p.odds).toEqual([]);
  });

  test("unpublished prizes (onchain_index null) are excluded", () => {
    const prizes = pool();
    prizes[0]!.onchain_index = null;
    expect(availablePool(prizes).map((x) => x.id)).toEqual(["r", "e", "l"]);
  });
});

describe("prizeBonus", () => {
  test("rarity default", () => expect(prizeBonus(rules, { id: "x", rarity: "epic" })).toBe(250n));
  test("override wins, including 0", () => {
    const r = { ...rules, points: { ...rules.points, prize_bonus_overrides: { x: "0", y: "1234" } } };
    expect(prizeBonus(r, { id: "x", rarity: "legendary" })).toBe(0n);
    expect(prizeBonus(r, { id: "y", rarity: "common" })).toBe(1234n);
  });
  test("unknown rarity earns nothing", () => expect(prizeBonus(rules, { id: "x", rarity: "mythic" })).toBe(0n));
});

describe("formatPoints", () => {
  test("bigint-safe separators", () => {
    expect(formatPoints("123456789012345678901234567890")).toBe("123,456,789,012,345,678,901,234,567,890");
    expect(formatPoints(-1234n)).toBe("-1,234");
    expect(formatPoints(null)).toBe("0");
    expect(formatPoints("999")).toBe("999");
  });
});
