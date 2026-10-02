import { useCallback, useRef, useState } from "react";
import { GotchaMachine, type DrawStatus, type GotchaPrize } from "./GotchaMachine";

/** Same prizes the app ships with — used if the live prize list hasn't loaded. */
export const DEMO_PRIZES: GotchaPrize[] = [
  { id: "demo-common", name: "Banana Chip", rarity: "common", points: 50, weight: 600, inventory: null },
  { id: "demo-rare", name: "Silver Crate", rarity: "rare", points: 150, weight: 280, inventory: null },
  { id: "demo-epic", name: "Gold Crate", rarity: "epic", points: 400, weight: 100, inventory: 500 },
  { id: "demo-legendary", name: "Charleston VIP Pass", rarity: "legendary", points: 1000, weight: 20, inventory: 20 },
];

function randomWord(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}

/** The same weighted pick the GotchaVRF contract makes on-chain. */
function pick(prizes: GotchaPrize[], word: bigint) {
  const live = prizes.filter((p) => p.inventory !== 0 && (p.weight ?? 0) > 0);
  const total = BigInt(live.reduce((s, p) => s + (p.weight ?? 0), 0));
  if (total === 0n) return prizes[0]!;
  let roll = word % total;
  for (const p of live) {
    const w = BigInt(p.weight ?? 0);
    if (roll < w) return p;
    roll -= w;
  }
  return live[0]!;
}

/**
 * The real gotcha machine with simulated draws. Nothing is sent to the server
 * and no points are awarded — it's for showing the machine off.
 */
export function DemoGotchaMachine({ prizes, credits: startCredits = 5 }: { prizes?: GotchaPrize[] | undefined; credits?: number }) {
  const pool = prizes?.length ? prizes : DEMO_PRIZES;
  const [credits, setCredits] = useState(startCredits);
  const draws = useRef(new Map<string, { readyAt: number; word: bigint }>());

  const onDraw = useCallback(async (count: number) => {
    await new Promise((r) => setTimeout(r, 900));
    const latency = 3500 + Math.random() * 3000;
    const spinIds = Array.from({ length: count }, () => crypto.randomUUID());
    for (const id of spinIds) draws.current.set(id, { readyAt: Date.now() + latency, word: randomWord() });
    setCredits((c) => Math.max(0, c - count));
    return { spinIds };
  }, []);

  const onCheck = useCallback(
    async (ids: string[]): Promise<DrawStatus[]> =>
      ids.map((id) => {
        const d = draws.current.get(id);
        if (!d || Date.now() < d.readyAt) return { id, status: "pending", prize_name: null, rarity: null, points: null };
        const p = pick(pool, d.word);
        return { id, status: "fulfilled", prize_id: p.id, prize_name: p.name, rarity: p.rarity, points: p.points, random_word: d.word.toString() };
      }),
    [pool],
  );

  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>Demo: draws are simulated here and award no points. Real spins are drawn on-chain by Chainlink VRF.</span>
        <button type="button" onClick={() => setCredits(startCredits)}>
          Refill {startCredits} spins
        </button>
      </div>
      <GotchaMachine
        credits={credits}
        prizes={pool}
        onDraw={onDraw}
        onCheck={onCheck}
        pollMs={700}
        footnote="Sign in to spin for real points."
      />
    </div>
  );
}
