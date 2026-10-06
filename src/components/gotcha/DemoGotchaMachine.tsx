import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GotchaMachine, type DrawStatus, type GotchaPrize } from "./GotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";
import { RefillDialog } from "@/components/wallet/RefillDialog";

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

const DEMO_COOLDOWN_MS = 30 * 60_000;
const DEMO_KEY = "gm-demo-last-spin";
const readLast = () => {
  try {
    return Number(localStorage.getItem(DEMO_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
};
const DEMO_PULLS_KEY = "gm-demo-pulls";
const readPulls = (): ShareSpin[] => {
  try {
    const x = JSON.parse(localStorage.getItem(DEMO_PULLS_KEY) ?? "[]");
    return Array.isArray(x) ? (x as ShareSpin[]).slice(-5) : [];
  } catch {
    return [];
  }
};
const fmt = (ms: number) => {
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Demo machine for signed-out visitors: one free spin every 30 minutes, simulated draws,
 * no prizes or points. Refill asks them to sign in to buy real spins.
 */
export function DemoGotchaMachine({ prizes }: { prizes?: GotchaPrize[] | undefined }) {
  const pool = prizes?.length ? prizes : DEMO_PRIZES;
  const [lastSpin, setLastSpin] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [refillOpen, setRefillOpen] = useState(false);
  const [refillAttention, setRefillAttention] = useState(false);
  const [revealedSpins, setRevealedSpins] = useState<ShareSpin[]>([]);
  const [inPlay, setInPlay] = useState(false);
  const draws = useRef(new Map<string, { readyAt: number; word: bigint }>());
  const refillRef = useRef<HTMLButtonElement>(null);
  const attentionTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setLastSpin(readLast());
    setRevealedSpins(readPulls());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      window.clearTimeout(attentionTimer.current);
    };
  }, []);

  const wait = Math.max(0, lastSpin + DEMO_COOLDOWN_MS - now);
  const credits = wait === 0 ? 1 : 0;

  const guideToRefill = useCallback(() => {
    const button = refillRef.current;
    if (!button) return;
    window.clearTimeout(attentionTimer.current);
    setRefillAttention(false);
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      button.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      button.focus({ preventScroll: true });
      setRefillAttention(true);
      attentionTimer.current = window.setTimeout(() => setRefillAttention(false), 1800);
    });
  }, []);

  const onDraw = useCallback(async (count: number) => {
    const at = Date.now();
    try {
      localStorage.setItem(DEMO_KEY, String(at));
    } catch {
      /* storage unavailable */
    }
    setLastSpin(at);
    await new Promise((r) => setTimeout(r, 900));
    const latency = 3500 + Math.random() * 3000;
    const spinIds = Array.from({ length: Math.min(count, 1) }, () => crypto.randomUUID());
    for (const id of spinIds) draws.current.set(id, { readyAt: Date.now() + latency, word: randomWord() });
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

  const showShare = credits === 0 && !inPlay && revealedSpins.length > 0;

  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>
          Demo: 1 free spin every 30 minutes · no prizes or points.{" "}
          {credits === 0 && !inPlay ? <b>Next demo spin in {fmt(wait)}.</b> : null} Sign in to play for real.
        </span>
        <span className="gm-bar-actions">
          {showShare && <ShareSpinsButton spins={revealedSpins} demo />}
          <Button
            ref={refillRef}
            type="button"
            size="sm"
            className={refillAttention ? "is-refill-attention" : ""}
            onClick={() => {
              setRefillAttention(false);
              setRefillOpen(true);
            }}
          >
            Refill spins
          </Button>
        </span>
      </div>
      <GotchaMachine
        credits={credits}
        prizes={pool}
        onDraw={onDraw}
        onCheck={onCheck}
        pollMs={700}
        maxPerSession={5}
        footnote="Demo spins are simulated and award no prizes. Sign in to spin for real."
        onNoSpins={guideToRefill}
        onReveal={(r) =>
          setRevealedSpins((xs) => {
            const next = [...xs, { prize_name: r.prize_name, rarity: r.rarity, points: r.points }].slice(-5);
            try {
              localStorage.setItem(DEMO_PULLS_KEY, JSON.stringify(next));
            } catch {
              /* storage unavailable */
            }
            return next;
          })
        }
        onBusyChange={setInPlay}
        demo
      />
      <RefillDialog open={refillOpen} onClose={() => setRefillOpen(false)} signedIn={false} onPurchased={() => setRefillOpen(false)} />
    </div>
  );
}
