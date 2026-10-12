// One prize order everywhere (admin Prizes & odds and the machine's Prize pool card):
// legendary → epic → rare → common; within a rarity the highest dollar value written in the name
// ("… $50 value") first, then more points, then name.

const RARITY_ORDER: Record<string, number> = { legendary: 0, epic: 1, rare: 2, common: 3 };

/** Dollar value written in a prize name, e.g. "Charleston VIP Pass $500 value" → 500 (0 when there is none). */
export function dollarValue(name: string) {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(name);
  return m ? Number(m[1]!.replace(/,/g, "")) || 0 : 0;
}

export function sortPrizes<T extends { name: string; rarity: string; points: number }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) ||
      dollarValue(b.name) - dollarValue(a.name) ||
      b.points - a.points ||
      a.name.localeCompare(b.name),
  );
}
