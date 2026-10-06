import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MotionIcon, Palmetto, Skyline, SoundIcon, TorchEmblem, prizeArt } from "./icons";
import { createSfx, type Sfx } from "./sound";
import { createJukebox, type Jukebox } from "./music";

export type GotchaPrize = {
  id: string;
  name: string;
  rarity: string;
  points: number;
  weight?: number;
  inventory?: number | null;
};

/** One capsule's state as reported by the server (mirrors the `checkDraw` server function). */
export type DrawStatus = {
  id: string;
  status: "pending" | "fulfilled" | "refunded";
  prize_id?: string | null | undefined;
  prize_name: string | null;
  rarity: string | null;
  points: number | null;
  random_word?: string | null | undefined;
  verify_url?: string | undefined;
};

export type GotchaResult = {
  id: string;
  prize_name: string;
  rarity: string;
  points: number;
  prize_id?: string | null | undefined;
  random_word?: string | null | undefined;
  verify_url?: string | undefined;
};

type Props = {
  credits: number;
  prizes: GotchaPrize[];
  /** Ask the chain for `count` capsules (one Chainlink VRF request). Resolves once the request is sent. */
  onDraw: (count: number) => Promise<{ spinIds: string[]; txUrl?: string | undefined }>;
  /** Report where each capsule's draw stands. Called repeatedly while Chainlink is drawing. */
  onCheck: (spinIds: string[]) => Promise<DrawStatus[]>;
  /** Capsules already drawing (e.g. after a page reload) — the machine picks them back up. */
  resumeIds?: string[];
  /** Called once the session ends (all revealed, skipped or timed out) — refresh data here. */
  onSessionEnd?: () => void;
  onError?: (message: string) => void;
  maxPerSession?: number;
  pollMs?: number;
  drawTimeoutMs?: number;
  footnote?: string;
  /** Guide the player to an external refill control when the machine is empty. */
  onNoSpins?: () => void;
};

type Phase = "idle" | "requesting" | "drawing" | "rolling" | "charging" | "opening" | "revealed" | "complete";
type Motion =
  | { kind: "drift"; speed: number }
  | { kind: "roll"; from: number; to: number; start: number; dur: number; s: number; onDone: () => void };

const RARITY_LABEL: Record<string, string> = { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const TILE_COUNT = 12;
const IDLE_SPEED = 9; // deg/s
const DRAW_SPEED = 330; // deg/s while Chainlink is drawing

const FALLBACK_PRIZES: GotchaPrize[] = [
  { id: "f1", name: "Banana Chip", rarity: "common", points: 50, weight: 600 },
  { id: "f2", name: "Silver Crate", rarity: "rare", points: 150, weight: 280 },
  { id: "f3", name: "Gold Crate", rarity: "epic", points: 400, weight: 100 },
  { id: "f4", name: "Charleston VIP Pass", rarity: "legendary", points: 1000, weight: 20 },
];

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Cubic with initial slope s (so a spinning reel hands off smoothly) and zero end slope. */
const ease = (t: number, s: number) => (s - 2) * t ** 3 + (3 - 2 * s) * t ** 2 + s * t;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function shortWord(word?: string | null) {
  if (!word) return null;
  try {
    const hex = BigInt(word).toString(16).padStart(64, "0");
    return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
  } catch {
    return null;
  }
}

function toResult(r: DrawStatus): GotchaResult {
  return {
    id: r.id,
    prize_name: r.prize_name ?? "Prize",
    rarity: r.rarity ?? "common",
    points: r.points ?? 0,
    prize_id: r.prize_id,
    random_word: r.random_word,
    verify_url: r.verify_url,
  };
}

export function GotchaMachine({
  credits,
  prizes,
  onDraw,
  onCheck,
  resumeIds,
  onSessionEnd,
  onError,
  maxPerSession = 5,
  pollMs = 1500,
  drawTimeoutMs = 240_000,
  footnote,
  onNoSpins,
}: Props) {
  const pool = prizes.length ? prizes : FALLBACK_PRIZES;
  const tiles = useMemo(() => {
    const n = Math.max(TILE_COUNT, pool.length);
    return Array.from({ length: n }, (_, i) => pool[i % pool.length]!);
  }, [pool]);
  const step = 360 / tiles.length;

  const [count, setCount] = useState(1);
  const [mode, setMode] = useState<"one" | "all">("one");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionSize, setSessionSize] = useState(0);
  const [results, setResults] = useState<GotchaResult[]>([]);
  const [cur, setCur] = useState(0);
  const [revealed, setRevealed] = useState(0);
  /** Prizes from earlier spins, in spin order — slot 1 is spin 1, slot 2 is spin 2… */
  const [history, setHistory] = useState<GotchaResult[]>([]);
  /** Tray slot where this pull's first capsule goes. */
  const [offset, setOffset] = useState(0);
  /** How many of this pull's prizes have flown into their tray slot. */
  const [landed, setLanded] = useState(0);
  /** The prize has left the card for the tray; a fresh sealed capsule waits in the vault. */
  const [parked, setParked] = useState(false);
  const [flying, setFlying] = useState(false);
  const [winTile, setWinTile] = useState<number | null>(null);
  const [requestUrl, setRequestUrl] = useState<string | undefined>();
  const [soundOn, setSoundOn] = useState(true);
  const [reduce, setReduce] = useState(false);
  const [leverKey, setLeverKey] = useState(0);
  const [confetti, setConfetti] = useState(0);

  const vaultRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const reelRef = useRef<HTMLDivElement>(null);
  const faceRefs = useRef<(HTMLDivElement | null)[]>([]);
  const visible = useRef(true);
  const pointerRef = useRef<HTMLDivElement>(null);
  const angle = useRef(0);
  const velocity = useRef(IDLE_SPEED);
  const motion = useRef<Motion>({ kind: "drift", speed: IDLE_SPEED });
  const timers = useRef<number[]>([]);
  const sfx = useRef<Sfx | null>(null);
  const jukebox = useRef<Jukebox | null>(null);
  const resultsRef = useRef<GotchaResult[]>([]);
  const historyRef = useRef<GotchaResult[]>([]);
  const revealedRef = useRef(0);
  const offsetRef = useRef(0);
  const modeRef = useRef(mode);
  const reduceRef = useRef(reduce);
  const ended = useRef(true);
  const mounted = useRef(true);
  const drawToken = useRef(0);
  const resumed = useRef(false);
  const onEndRef = useRef(onSessionEnd);
  modeRef.current = mode;
  reduceRef.current = reduce;
  onEndRef.current = onSessionEnd;

  // ---- preferences (client only) ----
  useEffect(() => {
    try {
      const s = localStorage.getItem("gm-sound");
      if (s != null) setSoundOn(s === "1");
      const r = localStorage.getItem("gm-reduce");
      // Full motion by default (the spin is the experience); players can switch on "Reduce motion" themselves.
      if (r != null) setReduce(r === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    sfx.current?.setEnabled(soundOn);
    jukebox.current?.setEnabled(soundOn);
    try { localStorage.setItem("gm-sound", soundOn ? "1" : "0"); } catch { /* ignore */ }
  }, [soundOn]);
  useEffect(() => {
    try { localStorage.setItem("gm-reduce", reduce ? "1" : "0"); } catch { /* ignore */ }
  }, [reduce]);

  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const endSession = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    onEndRef.current?.();
  }, []);

  useEffect(() => {
    jukebox.current ??= createJukebox();
    jukebox.current.preload();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      drawToken.current++;
      clearTimers();
      if (!ended.current) onEndRef.current?.();
      jukebox.current?.dispose();
    };
  }, []);

  // ---- reel animation loop ----
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastIdx = Math.round(angle.current / step);
    let lastWritten = Number.NaN;
    const loop = (now: number) => {
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      const m = motion.current;
      if (m.kind === "drift") {
        const sp = reduceRef.current ? 0 : m.speed;
        angle.current += sp * dt;
        velocity.current = sp;
      } else {
        const t = Math.min(1, (now - m.start) / m.dur);
        angle.current = m.from + (m.to - m.from) * ease(t, m.s);
        velocity.current = 0;
        if (t >= 1) {
          motion.current = { kind: "drift", speed: 0 };
          m.onDone();
        }
      }
      // Only the reel and the 13 moving faces get new transforms — no style recalcs for the rest of the machine.
      if (visible.current && angle.current !== lastWritten) {
        lastWritten = angle.current;
        const a = angle.current;
        if (reelRef.current) reelRef.current.style.transform = `rotate(${a}deg)`;
        const faces = faceRefs.current;
        for (let i = 0; i < faces.length; i++) {
          const f = faces[i];
          if (f) f.style.transform = `rotate(${-(i * step + a)}deg)`;
        }
      }
      const idx = Math.round(angle.current / step);
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (m.kind === "roll" && visible.current) {
          pointerRef.current?.animate(
            [{ transform: "translateX(-50%) rotate(0)" }, { transform: "translateX(-50%) rotate(-14deg)" }, { transform: "translateX(-50%) rotate(0)" }],
            { duration: 120 },
          );
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Stop painting the reel while the machine is off-screen (the spin logic keeps running).
    let io: IntersectionObserver | undefined;
    if (rootRef.current && "IntersectionObserver" in window) {
      io = new IntersectionObserver(([e]) => {
        visible.current = !!e?.isIntersecting;
        if (visible.current) lastWritten = Number.NaN;
      });
      io.observe(rootRef.current);
    }
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [step]);

  // ---- helpers ----
  const pickTile = (r: GotchaResult) => {
    let idx = tiles.map((t, i) => (t.id === r.prize_id || t.name === r.prize_name ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) idx = tiles.map((t, i) => (t.rarity === r.rarity ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) idx = [0];
    return idx[Math.floor(Math.random() * idx.length)] ?? 0;
  };
  const targetAngle = (tile: number, loops: number) => {
    const from = angle.current;
    const jitter = (Math.random() - 0.5) * step * 0.5;
    return from + mod(-tile * step - from, 360) + 360 * loops + jitter;
  };

  const waiting = phase === "requesting" || phase === "drawing";
  const busy = waiting || phase === "rolling" || phase === "charging" || phase === "opening";
  const drawn = results.length;
  const remaining = drawn - revealed;
  const maxLoad = clamp(Math.min(maxPerSession, credits), 0, maxPerSession);
  useEffect(() => {
    if (phase === "idle" && maxLoad > 0 && count > maxLoad) setCount(maxLoad);
  }, [maxLoad, count, phase]);

  const resetToIdle = useCallback(() => {
    drawToken.current++;
    clearTimers();
    // Prizes already revealed stay in their tray slots (spin order).
    const finished = resultsRef.current.slice(0, revealedRef.current);
    if (finished.length) {
      historyRef.current = [...historyRef.current, ...finished];
      setHistory(historyRef.current);
    }
    resultsRef.current = [];
    setResults([]);
    revealedRef.current = 0;
    setRevealed(0);
    setLanded(0);
    setParked(false);
    setSessionSize(0);
    setWinTile(null);
    setRequestUrl(undefined);
    setPhase("idle");
    motion.current = { kind: "drift", speed: IDLE_SPEED };
    jukebox.current?.stop(0.8);
  }, []);

  /** Fly the revealed prize from the card into its numbered tray slot, then show it there. */
  const flyToSlot = useCallback((k: number) => {
    const land = () => {
      setLanded((n) => Math.max(n, k + 1));
      setParked(true);
    };
    const root = rootRef.current;
    const art = root?.querySelector<SVGSVGElement>(".gm-reveal .gm-reveal-art");
    const slot = root?.querySelector<HTMLElement>(`[data-slot="${offsetRef.current + k}"] .gm-slot-ball`);
    if (!root || !art || !slot || reduceRef.current || !visible.current || typeof art.animate !== "function") return land();
    const a = art.getBoundingClientRect();
    const b = slot.getBoundingClientRect();
    if (!a.width || !b.width) return land();
    const ghost = art.cloneNode(true) as SVGSVGElement;
    ghost.removeAttribute("class");
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${a.left}px`,
      top: `${a.top}px`,
      width: `${a.width}px`,
      height: `${a.height}px`,
      zIndex: "60",
      pointerEvents: "none",
      filter: "drop-shadow(0 6px 10px rgba(0,0,0,.5))",
    });
    document.body.appendChild(ghost);
    art.style.visibility = "hidden";
    setFlying(true);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const end = (b.width * 0.72) / a.width;
    const anim = ghost.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 50}px) scale(${(1 + end) / 2 + 0.2})`, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) scale(${end})` },
      ],
      { duration: 720, easing: "cubic-bezier(.45, 0, .3, 1)", fill: "forwards" },
    );
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ghost.remove();
      setFlying(false);
      land();
    };
    anim.onfinish = finish;
    window.setTimeout(finish, 1000); // never leave a prize mid-air
  }, []);

  const revealCapsule = useCallback(
    (i: number) => {
      const r = resultsRef.current[i];
      if (!r) return;
      const fast = modeRef.current === "all";
      const rm = reduceRef.current;
      const tile = pickTile(r);
      setCur(i);
      setWinTile(null);
      setParked(false);
      setPhase("rolling");
      if (!jukebox.current?.playing) jukebox.current?.start();

      const afterRoll = () => {
        if (!mounted.current) return;
        setWinTile(tile);
        setPhase("charging");
        after(rm ? 150 : fast ? 520 : 820, () => {
          setPhase("opening");
          // Music fades out as the capsule opens — on the last capsule, or between capsules when revealing one by one.
          if (i + 1 >= resultsRef.current.length || modeRef.current === "one") jukebox.current?.stop(1.5);
          sfx.current?.pop();
          after(rm ? 120 : 620, () => {
            setPhase("revealed");
            revealedRef.current = i + 1;
            setRevealed(i + 1);
            sfx.current?.fanfare(r.rarity);
            if (!rm && (r.rarity === "epic" || r.rarity === "legendary")) setConfetti((k) => k + 1);
            // Show the prize on the card for a moment, then send it to its tray slot.
            after(rm ? 0 : 1300, () => flyToSlot(i));
            const total = resultsRef.current.length;
            if (i + 1 >= total) {
              endSession();
              if (total > 1) after(rm ? 900 : 2600, () => setPhase("complete"));
            } else if (modeRef.current === "all") {
              after(rm ? 700 : 2300, () => revealCapsule(i + 1));
            }
          });
        });
      };

      if (rm) {
        angle.current = targetAngle(tile, 0);
        motion.current = { kind: "drift", speed: 0 };
        after(180, afterRoll);
        return;
      }
      const loops = fast ? 2 : 3;
      const to = targetAngle(tile, loops);
      const dur = fast ? 2000 : 3500;
      const s = clamp((velocity.current * (dur / 1000)) / Math.max(1, to - angle.current), 1.1, 2.4);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        afterRoll();
      };
      const roll: Motion = { kind: "roll", from: angle.current, to, start: performance.now(), dur, s, onDone: finish };
      motion.current = roll;
      // If the browser pauses animation frames (hidden tab, low-power mode, embedded preview), finish on time anyway.
      after(dur + 350, () => {
        if (motion.current === roll) {
          angle.current = to;
          motion.current = { kind: "drift", speed: 0 };
        }
        finish();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tiles, step, flyToSlot],
  );

  /** Keep the reel spinning until Chainlink has answered for every capsule. */
  const waitForDraw = useCallback(
    async (ids: string[]) => {
      const token = ++drawToken.current;
      ended.current = false;
      setSessionSize(ids.length);
      setPhase("drawing");
      motion.current = { kind: "drift", speed: DRAW_SPEED };
      const started = Date.now();
      while (mounted.current && token === drawToken.current) {
        await sleep(pollMs);
        if (!mounted.current || token !== drawToken.current) return;
        let rows: DrawStatus[];
        try {
          rows = await onCheck(ids);
        } catch {
          rows = [];
        }
        if (rows.length === ids.length && rows.every((r) => r.status !== "pending")) {
          const got = rows.filter((r) => r.status === "fulfilled").map(toResult);
          const returned = rows.length - got.length;
          if (returned) onError?.(`${plural(returned, "spin")} returned — that prize ran out on-chain.`);
          if (!got.length) {
            endSession();
            resetToIdle();
            return;
          }
          resultsRef.current = got;
          setResults(got);
          setSessionSize(got.length);
          revealCapsule(0);
          return;
        }
        if (Date.now() - started > drawTimeoutMs) {
          onError?.("Chainlink is taking longer than usual. Your capsules will appear in Recent spins as soon as they land.");
          endSession();
          resetToIdle();
          return;
        }
      }
    },
    [onCheck, onError, pollMs, drawTimeoutMs, endSession, resetToIdle, revealCapsule],
  );

  // Pick up a draw that was already in flight (page reload, second tab…).
  useEffect(() => {
    if (resumed.current || !resumeIds?.length || phase !== "idle") return;
    resumed.current = true;
    void waitForDraw(resumeIds);
  }, [resumeIds, phase, waitForDraw]);

  const pull = async () => {
    if (busy || credits < 1) return;
    resumed.current = true;
    resetToIdle();
    sfx.current ??= createSfx();
    sfx.current.setEnabled(soundOn);
    // Start the party music right inside the tap — mobile browsers only allow audio that begins from a gesture.
    jukebox.current ??= createJukebox();
    jukebox.current.setEnabled(soundOn);
    jukebox.current.start();
    setLeverKey((k) => k + 1);

    const n = Math.min(count, credits, maxPerSession);
    const before = historyRef.current;
    const base = before.length + n > maxPerSession ? [] : before; // tray full → start a new round at slot 1
    historyRef.current = base;
    setHistory(base);
    offsetRef.current = base.length;
    setOffset(base.length);
    setSessionSize(n);
    setPhase("requesting");
    motion.current = { kind: "drift", speed: DRAW_SPEED };

    let handle: { spinIds: string[]; txUrl?: string | undefined };
    try {
      handle = await onDraw(n);
    } catch (e) {
      onError?.((e as Error).message || "Couldn't start the draw");
      historyRef.current = before; // nothing was drawn — keep the tray as it was
      setHistory(before);
      if (mounted.current) resetToIdle();
      return;
    }
    if (!mounted.current) return;
    setRequestUrl(handle.txUrl);
    await waitForDraw(handle.spinIds);
  };

  const skip = () => {
    if (!drawn || waiting || phase === "complete" || (phase === "revealed" && remaining === 0)) return;
    clearTimers();
    const last = resultsRef.current[drawn - 1];
    if (!last) return;
    const tile = pickTile(last);
    angle.current = targetAngle(tile, 0);
    motion.current = { kind: "drift", speed: 0 };
    setCur(drawn - 1);
    setWinTile(tile);
    revealedRef.current = drawn;
    setRevealed(drawn);
    setLanded(drawn);
    setParked(true);
    setPhase(drawn > 1 ? "complete" : "revealed");
    jukebox.current?.stop(0.8);
    endSession();
  };

  const chooseMode = (m: "one" | "all") => {
    setMode(m);
    modeRef.current = m;
    if (m === "all" && phase === "revealed" && remaining > 0) revealCapsule(revealed);
  };

  // ---- derived UI ----
  const active = results[cur];
  const sessionPts = results.slice(0, revealed).reduce((s, r) => s + r.points, 0);
  const rarityOf = (phase === "charging" || phase === "opening" || phase === "revealed") && active ? active.rarity : undefined;
  const sessionDone = drawn > 0 && remaining === 0 && !busy;
  /** Verification links only appear when there's a real transaction to point at. */
  const link = (href: string | undefined, label: string, fallback: string = "Chainlink VRF draw") =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer" className="gm-link">
        {label} ↗
      </a>
    ) : (
      fallback
    );

  const status: { t: string; s: string; pill: ReactNode } = (() => {
    const i = cur + 1;
    switch (phase) {
      case "idle":
        return credits > 0
          ? { t: "Ready to pull", s: `Load ${plural(count, "capsule")} · ${plural(credits, "spin")} available`, pill: "Every draw powered by Chainlink VRF" }
          : { t: "Machine empty", s: "Burn a Level 4+ NFT to earn a free spin", pill: "Paid spins open when checkout is enabled." };
      case "requesting":
        return { t: "Requesting randomness…", s: `Sending ${plural(sessionSize, "capsule")} to Chainlink VRF`, pill: "Waiting for the request to confirm" };
      case "drawing":
        return { t: "Drawing on-chain…", s: "", pill: link(requestUrl, "View the request", "Waiting on Chainlink VRF") };
      case "rolling":
        return { t: "Prizes rotating…", s: `Capsule ${i} of ${drawn}`, pill: "Chainlink VRF draw" };
      case "charging":
      case "opening":
        return { t: `Opening capsule ${i}…`, s: "Seal breaking", pill: "Chainlink VRF draw" };
      case "revealed":
        return active
          ? {
              t: `${RARITY_LABEL[active.rarity] ?? active.rarity}!`,
              s: `${active.prize_name} · +${active.points} pts`,
              pill: remaining > 0 ? `${plural(remaining, "sealed capsule")} left` : link(active.verify_url ?? requestUrl, "Verify this draw on-chain"),
            }
          : { t: "", s: "", pill: "" };
      case "complete":
        return { t: "Session complete", s: `${plural(drawn, "capsule")} · +${sessionPts} pts`, pill: link(results[0]?.verify_url ?? requestUrl, "Verify these draws on-chain") };
    }
  })();

  // Tray slot j shows: earlier spins (history) → this pull's capsules → empty.
  const trayFull = history.length >= maxPerSession;
  const loadStart = trayFull ? 0 : history.length; // where the next pull's capsules will go
  const slotInfo = (j: number): { st: string; r?: GotchaResult | undefined; pick?: number } => {
    if (phase === "idle") {
      const pick = j - loadStart + 1; // capsules to load if this slot is tapped
      const selectable = j >= loadStart && pick <= maxLoad;
      if (selectable && pick <= count) return { st: "loaded", pick };
      if (j < history.length) return { st: trayFull ? "past" : "revealed", r: history[j], ...(selectable ? { pick } : {}) };
      return selectable ? { st: "empty", pick } : { st: "off" };
    }
    if (j < offset) return { st: "revealed", r: history[j] };
    const k = j - offset;
    if (k >= sessionSize) return { st: "off" };
    if (waiting) return { st: "drawing" };
    if (k < landed) return { st: "revealed", r: results[k] };
    if (k === cur && busy) return { st: "active" };
    return { st: k < drawn ? "sealed" : "off" };
  };
  /** Between spins, tapping a free slot sets how many capsules the next pull loads. */
  const pickBetweenSpins = (j: number) => {
    const h = history.length + drawn; // this pull's prizes join the record
    const start = h >= maxPerSession ? 0 : h;
    const p = j - start + 1;
    return p >= 1 && p <= maxLoad && start + p <= maxPerSession ? p : null;
  };
  useEffect(() => {
    // Don't ask for more capsules than there are free slots left in this round.
    const free = maxPerSession - history.length;
    if (phase === "idle" && free > 0 && count > free) setCount(free);
  }, [phase, history.length, count, maxPerSession]);

  let cta: { label: string; sub?: string; onClick: () => void; disabled?: boolean };
  if (phase === "requesting") cta = { label: "Requesting…", onClick: () => {}, disabled: true };
  else if (phase === "drawing") cta = { label: "Drawing on-chain…", sub: "Chainlink VRF", onClick: () => {}, disabled: true };
  else if (busy) cta = { label: "Revealing…", onClick: () => {}, disabled: true };
  else if (phase === "revealed" && remaining > 0) cta = { label: `Reveal capsule ${revealed + 1}`, sub: `${remaining} sealed`, onClick: () => revealCapsule(revealed) };
  else if (sessionDone) cta = credits > 0 ? { label: "Click To Spin", sub: `${plural(credits, "spin")} left`, onClick: pull } : { label: "No spins available", sub: "Refill to keep playing", onClick: onNoSpins ?? resetToIdle, disabled: !onNoSpins };
  else cta = credits > 0 ? { label: "Click To Spin", sub: plural(count, "capsule"), onClick: pull } : { label: "No spins available", sub: onNoSpins ? "Tap to refill" : undefined, onClick: onNoSpins ?? (() => {}), disabled: !onNoSpins };

  const canPull = phase === "idle" && credits > 0;
  const canLever = (phase === "idle" || sessionDone) && credits > 0;
  const spinReady = credits > 0 && (phase === "idle" || sessionDone);
  const rarityVar = rarityOf ? ({ "--rar": `var(--gm-${rarityOf})` } as CSSProperties) : undefined;
  const poolTotal = pool.reduce((s, p) => s + (p.inventory === 0 ? 0 : p.weight ?? 0), 0);
  const word = active && (phase === "revealed" || phase === "charging" || phase === "opening") ? shortWord(active.random_word) : null;

  return (
    <div ref={rootRef} className={`gm${reduce ? " is-reduced" : ""} is-${phase}${parked ? " is-parked" : ""}${flying ? " is-flying" : ""}`}>
      <div className="gm-sky" aria-hidden>
        <div className="gm-stars" />
        <div className="gm-moon" />
        <Skyline className="gm-skyline" />
        <Palmetto className="gm-palm gm-palm-l" />
        <Palmetto className="gm-palm gm-palm-l2" />
        <Palmetto className="gm-palm gm-palm-r" flip />
        <Palmetto className="gm-palm gm-palm-r2" flip />
        <span className="gm-script gm-script-l">Charleston<br />Always a<br />Good Game</span>
        <span className="gm-script gm-script-r">The Games<br />Are Calling</span>
      </div>

      <div className="gm-grid">
        {/* ---------- session card ---------- */}
        <aside className="gm-card gm-session">
          <p className="gm-card-kicker">Your machine</p>
          <div className="gm-big">{credits}</div>
          <p className="gm-card-label">spin{credits === 1 ? "" : "s"} available</p>
          <hr />
          <div className="gm-kv"><span>This session</span><b>+{sessionPts} pts</b></div>
          <div className="gm-kv"><span>Capsules opened</span><b>{revealed}/{sessionSize || count}</b></div>
          <hr />
          <p className="gm-vrf-badge">Chainlink VRF</p>
          <ul className="gm-checks">
            <li>Each capsule gets its own on-chain random number</li>
            <li>The smart contract picks the prize</li>
            <li>Every draw can be checked on-chain</li>
          </ul>
          {footnote && <p className="gm-foot">{footnote}</p>}
        </aside>

        {/* ---------- machine ---------- */}
        <section className="gm-center">
          <div className="gm-machine">
            <div className="gm-marquee">
              <span className="gm-mq-go">Go</span>
              <span className="gm-mq-main">ApeGames</span>
              <span className="gm-mq-year">2026</span>
            </div>

            <div className="gm-vault" ref={vaultRef} style={rarityVar}>
              <div className="gm-bulbs" aria-hidden>
                {Array.from({ length: 28 }, (_, i) => (
                  <i key={i} style={{ "--i": i } as CSSProperties} />
                ))}
              </div>
              <div className="gm-well">
                <div className="gm-swirl" />
                <div className="gm-reel" ref={reelRef}>
                  {tiles.map((t, i) => {
                    const Art = prizeArt(t.name, t.rarity);
                    return (
                      <div
                        key={i}
                        className={`gm-tile r-${t.rarity}${winTile === i ? " is-win" : ""}`}
                        style={{ "--a": `${i * step}deg` } as CSSProperties}
                        title={t.name}
                      >
                        <div
                          className="gm-tile-face"
                          ref={(el) => {
                            faceRefs.current[i] = el;
                          }}
                        >
                          <Art />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="gm-core">
                  {((phase !== "revealed" && phase !== "complete") || (phase === "revealed" && parked)) && (
                    <div className="gm-capsule">
                      <div className="gm-cap-top" />
                      <div className="gm-cap-bot" />
                      <TorchEmblem className="gm-cap-emblem" />
                      <div className="gm-cap-shine" />
                    </div>
                  )}
                  {(phase === "opening" || (phase === "revealed" && !parked)) && <div className="gm-burst" aria-hidden />}
                </div>

                {phase === "revealed" && !parked && active && (
                  <div key={active.id} className={`gm-reveal r-${active.rarity}`}>
                    {(() => {
                      const Art = prizeArt(active.prize_name, active.rarity);
                      return <Art className="gm-reveal-art" />;
                    })()}
                    <span className="gm-reveal-rarity">{RARITY_LABEL[active.rarity] ?? active.rarity}</span>
                    <span className="gm-reveal-name">{active.prize_name}</span>
                    <span className="gm-reveal-pts">+{active.points} pts</span>
                    {word && <span className="gm-reveal-vrf">VRF {word}</span>}
                  </div>
                )}
                {phase === "complete" && (
                  <div className="gm-reveal gm-summary">
                    <span className="gm-reveal-rarity">Session total</span>
                    <span className="gm-summary-pts">+{sessionPts}</span>
                    <span className="gm-reveal-name">{plural(drawn, "capsule")} opened</span>
                  </div>
                )}
              </div>
              <div className="gm-pointer" ref={pointerRef} aria-hidden />

              {confetti > 0 && !reduce && (
                <div className="gm-confetti" key={confetti} aria-hidden>
                  {Array.from({ length: 40 }, (_, i) => (
                    <i
                      key={i}
                      style={{
                        "--dx": `${(Math.random() - 0.5) * 520}px`,
                        "--dy": `${-120 - Math.random() * 260}px`,
                        "--r": `${Math.random() * 720 - 360}deg`,
                        "--d": `${Math.random() * 0.25}s`,
                        "--c": ["#f6c343", "#d7262f", "#fff6e3", "#38bdf8", "#b36bff"][i % 5],
                      } as CSSProperties}
                    />
                  ))}
                </div>
              )}
            </div>

            <button
              key={leverKey}
              type="button"
              className={`gm-lever${leverKey ? " is-pulled" : ""}`}
              onClick={pull}
              disabled={!canLever}
              aria-label="Pull the lever"
            >
              <span className="gm-lever-arm"><span className="gm-lever-knob" /></span>
              <span className="gm-lever-hub" />
            </button>

            <div className="gm-plate" role="status" aria-live="polite" style={rarityVar}>
              <div className="gm-plate-row">
                <span className={`gm-spinner${busy ? " is-on" : ""}`} aria-hidden>
                  {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ "--i": i } as CSSProperties} />)}
                </span>
                <div>
                  <p className="gm-plate-title">{status.t}</p>
                  {status.s && <p className="gm-plate-sub">{status.s}</p>}
                </div>
              </div>
              <p className="gm-plate-pill">{status.pill}</p>
            </div>

            <div className="gm-body">
              <div className="gm-tray" role="group" aria-label="Your spins">
                {Array.from({ length: maxPerSession }, (_, k) => {
                  const info = slotInfo(k);
                  const { st, r } = info;
                  const between = sessionDone && credits > 0 ? pickBetweenSpins(k) : null;
                  const pick = canPull ? info.pick : between ?? undefined;
                  const shown = r && (st === "revealed" || st === "past");
                  const Art = shown ? prizeArt(r.prize_name, r.rarity) : null;
                  return (
                    <button
                      key={k}
                      type="button"
                      data-slot={k}
                      className={`gm-slot s-${st}${shown ? ` r-${r.rarity}` : ""}`}
                      disabled={pick == null}
                      onClick={() => {
                        if (pick == null) return;
                        if (!canPull) resetToIdle(); // between spins: file this pull's prizes, then load the next
                        setCount(pick);
                      }}
                      aria-label={shown ? `Spin ${k + 1}: ${r.prize_name}` : pick != null ? `Load ${plural(pick, "capsule")}` : `Slot ${k + 1}`}
                    >
                      <span className="gm-slot-ball">{Art ? <Art className="gm-slot-art" /> : null}</span>
                      <span className="gm-slot-n">{k + 1}</span>
                    </button>
                  );
                })}
              </div>

              <div className="gm-modes" role="radiogroup" aria-label="Reveal mode">
                {(["one", "all"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} className={`gm-mode${mode === m ? " is-on" : ""}`} onClick={() => chooseMode(m)}>
                    <span className="gm-radio" />
                    {m === "one" ? "Reveal one by one" : "Reveal all"}
                  </button>
                ))}
              </div>

              <button type="button" className={`gm-cta${spinReady ? " is-ready" : ""}`} onClick={cta.onClick} disabled={cta.disabled}>
                <span>{cta.label}</span>
                {cta.sub && <small>{cta.sub}</small>}
              </button>
            </div>

            <div className="gm-tools">
              <button type="button" className="gm-tool" onClick={() => setSoundOn((v) => !v)} aria-pressed={soundOn}>
                <SoundIcon on={soundOn} /> <span>{soundOn ? "Sound on" : "Muted"}</span>
              </button>
              <button type="button" className="gm-tool" onClick={() => setReduce((v) => !v)} aria-pressed={reduce}>
                <MotionIcon /> <span>Reduce motion</span>
              </button>
              <button
                type="button"
                className="gm-tool gm-skip"
                onClick={skip}
                disabled={!drawn || waiting || phase === "idle" || phase === "complete" || (phase === "revealed" && remaining === 0)}
              >
                <span>Skip animation →</span>
              </button>
            </div>
          </div>
        </section>

        {/* ---------- prize pool ---------- */}
        <aside className="gm-card gm-pool">
          <p className="gm-card-kicker">Prize pool</p>
          <ul>
            {pool.map((p) => {
              const Art = prizeArt(p.name, p.rarity);
              const odds = poolTotal && p.weight != null && p.inventory !== 0 ? (p.weight / poolTotal) * 100 : null;
              return (
                <li key={p.id} className={`r-${p.rarity}`}>
                  <span className="gm-pool-art"><Art /></span>
                  <span className="gm-pool-txt">
                    <b>{p.name}</b>
                    <small>
                      {RARITY_LABEL[p.rarity] ?? p.rarity} · +{p.points}
                      {odds != null && ` · ${odds < 1 ? odds.toFixed(1) : Math.round(odds)}%`}
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="gm-pool-note">Odds are set in the draw contract on-chain.</p>
        </aside>
      </div>

      <footer className="gm-banner">
        <span className="gm-banner-mark" aria-hidden>☾</span>
        <div>
          <p className="gm-banner-title">The games are calling</p>
          <p className="gm-banner-sub">ApeGames 2026 starts before game day.</p>
        </div>
        <span className="gm-banner-script">Charleston<br />Forever</span>
      </footer>
    </div>
  );
}
