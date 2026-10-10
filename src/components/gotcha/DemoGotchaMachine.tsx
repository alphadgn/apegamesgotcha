import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { redeemDemoSpins } from "@/lib/app.functions";
import { GotchaMachine, type DrawStatus, type GotchaPrize } from "./GotchaMachine";
import { ShareSpinsButton, type ShareSpin } from "./ShareSpins";
import { openRefill, openSignIn } from "@/components/wallet/walletUi";

/** Same prizes the app ships with — used if the live prize list hasn't loaded. */
export const DEMO_PRIZES: GotchaPrize[] = [
  {
    id: "demo-common",
    name: "Banana Chip",
    rarity: "common",
    points: 50,
    weight: 600,
    inventory: null,
  },
  {
    id: "demo-rare",
    name: "Silver Crate",
    rarity: "rare",
    points: 150,
    weight: 280,
    inventory: null,
  },
  { id: "demo-epic", name: "Gold Crate", rarity: "epic", points: 400, weight: 100, inventory: 500 },
  {
    id: "demo-legendary",
    name: "Charleston VIP Pass",
    rarity: "legendary",
    points: 1000,
    weight: 20,
    inventory: 20,
  },
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
const readLast = (key: string) => {
  try {
    return Number(localStorage.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
};
const DEMO_PULLS_KEY = "gm-demo-pulls";
const readPulls = (key: string): ShareSpin[] => {
  try {
    const x = JSON.parse(localStorage.getItem(key) ?? "[]");
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
 * no prizes or points. Refill opens sign-in, then the payment window.
 */
export function DemoGotchaMachine({
  prizes,
  userId,
  grantedSpins = 0,
  savedRealSpins = 0,
  onBusyChange,
}: {
  prizes?: GotchaPrize[] | undefined;
  /** Signed-in player out of real spins: same free practice spin, Refill opens checkout directly. */
  userId?: string | undefined;
  /** Practice spins an administrator granted this player: usable right away, no cooldown. */
  grantedSpins?: number | undefined;
  /** Real spins the player holds that wait for the on-chain draw to open (shown, never blocked by the timer). */
  savedRealSpins?: number | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
}) {
  const lastKey = userId ? `${DEMO_KEY}:${userId}` : DEMO_KEY;
  const pullsKey = userId ? `${DEMO_PULLS_KEY}:${userId}` : DEMO_PULLS_KEY;
  const pool = prizes?.length ? prizes : DEMO_PRIZES;
  const [lastSpin, setLastSpin] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [refillAttention, setRefillAttention] = useState(false);
  const [revealedSpins, setRevealedSpins] = useState<ShareSpin[]>([]);
  const [inPlay, setInPlay] = useState(false);
  const draws = useRef(new Map<string, { readyAt: number; word: bigint }>());
  const refillRef = useRef<HTMLButtonElement>(null);
  const attentionTimer = useRef<number | undefined>(undefined);
  const redeem = useServerFn(redeemDemoSpins);
  // Granted spins used since the count was last loaded (the server count already reflects earlier ones).
  const [grantedUsed, setGrantedUsed] = useState(0);
  useEffect(() => setGrantedUsed(0), [grantedSpins]);
  const granted = userId ? Math.max(0, grantedSpins - grantedUsed) : 0;

  useEffect(() => {
    setLastSpin(readLast(lastKey));
    setRevealedSpins(readPulls(pullsKey));
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      window.clearTimeout(attentionTimer.current);
    };
  }, [lastKey, pullsKey]);

  const wait = Math.max(0, lastSpin + DEMO_COOLDOWN_MS - now);
  // Granted spins are usable immediately; the every-30-minutes free spin only counts once they're gone.
  // While real spins are saved for the on-chain draw, the player isn't out of spins, so no free-spin timer.
  const credits = granted > 0 ? granted : savedRealSpins > 0 ? 0 : wait === 0 ? 1 : 0;

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

  const onDraw = useCallback(
    async (count: number) => {
      let n = 0;
      // Granted spins first; the free every-30-minutes spin is only used once they're all gone.
      const fromGrant = Math.min(count, granted);
      if (fromGrant > 0) {
        const { used } = await redeem({ data: { count: fromGrant } });
        setGrantedUsed((u) => u + used);
        n += used;
      }
      if (n === 0 && granted === 0 && Date.now() >= lastSpin + DEMO_COOLDOWN_MS) {
        const at = Date.now();
        try {
          localStorage.setItem(lastKey, String(at));
        } catch {
          /* storage unavailable */
        }
        setLastSpin(at);
        n += 1;
      }
      if (n === 0) throw new Error("No free spins left right now");
      await new Promise((r) => setTimeout(r, 900));
      const latency = 3500 + Math.random() * 3000;
      const spinIds = Array.from({ length: n }, () => crypto.randomUUID());
      for (const id of spinIds)
        draws.current.set(id, { readyAt: Date.now() + latency, word: randomWord() });
      return { spinIds };
    },
    [granted, lastKey, lastSpin, redeem],
  );

  const onCheck = useCallback(
    async (ids: string[]): Promise<DrawStatus[]> =>
      ids.map((id) => {
        const d = draws.current.get(id);
        if (!d || Date.now() < d.readyAt)
          return { id, status: "pending", prize_name: null, rarity: null, points: null };
        const p = pick(pool, d.word);
        return {
          id,
          status: "fulfilled",
          prize_id: p.id,
          prize_name: p.name,
          rarity: p.rarity,
          points: p.points,
          random_word: d.word.toString(),
        };
      }),
    [pool],
  );

  const showShare = credits === 0 && !inPlay && revealedSpins.length > 0;

  return (
    <div className="gm-demo">
      <div className="gm-demo-bar">
        <span>
          {granted > 0 ? (
            <b>
              {granted} free practice spin{granted === 1 ? "" : "s"} from the ApeGames team, ready
              now.{" "}
            </b>
          ) : null}
          {savedRealSpins > 0 ? (
            <>
              {savedRealSpins} real spin{savedRealSpins === 1 ? "" : "s"} saved for when the
              on-chain draw opens.{" "}
            </>
          ) : null}
          {granted > 0 || savedRealSpins > 0 ? (
            granted > 0 ? (
              "Practice spins: no prizes or points. "
            ) : null
          ) : (
            <>
              Demo: 1 free spin every 30 minutes · no prizes or points.{" "}
              {credits === 0 && !inPlay ? <b>Next demo spin in {fmt(wait)}.</b> : null}{" "}
            </>
          )}
          {userId ? "Refill to play for real." : "Sign in to play for real."}
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
              if (userId) openRefill();
              else openSignIn({ then: "refill" }); // sign in first, then the payment window opens
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
        footnote={
          userId
            ? "Free spins are simulated and award no prizes. Refill to spin for real."
            : "Demo spins are simulated and award no prizes. Sign in to spin for real."
        }
        onNoSpins={guideToRefill}
        onReveal={(r) =>
          setRevealedSpins((xs) => {
            const next = [
              ...xs,
              { prize_name: r.prize_name, rarity: r.rarity, points: r.points },
            ].slice(-5);
            try {
              localStorage.setItem(pullsKey, JSON.stringify(next));
            } catch {
              /* storage unavailable */
            }
            return next;
          })
        }
        onBusyChange={(b) => {
          setInPlay(b);
          onBusyChange?.(b);
        }}
        demo
      />
    </div>
  );
}
