// Tiny synthesized sound effects (WebAudio) — no audio files to ship.
export type Sfx = ReturnType<typeof createSfx>;

export function createSfx() {
  let ctx: AudioContext | null = null;
  let enabled = true;

  const audio = () => {
    if (!enabled || typeof window === "undefined") return null;
    if (!ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };

  const tone = (freq: number, dur: number, type: OscillatorType = "square", vol = 0.04, delay = 0, slideTo?: number) => {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  const fanfares: Record<string, number[]> = {
    common: [523, 659],
    rare: [523, 659, 784],
    epic: [523, 659, 784, 1047],
    legendary: [523, 659, 784, 1047, 1319, 1568],
  };

  return {
    setEnabled(v: boolean) {
      enabled = v;
    },
    tick: () => tone(1500, 0.025, "square", 0.025),
    lever: () => {
      tone(180, 0.18, "sawtooth", 0.05, 0, 60);
      tone(90, 0.12, "square", 0.05, 0.2);
    },
    secure: () => tone(880, 0.08, "triangle", 0.06),
    lock: () => {
      tone(220, 0.09, "square", 0.06);
      tone(330, 0.12, "triangle", 0.05, 0.08);
    },
    charge: () => tone(200, 0.7, "sawtooth", 0.03, 0, 900),
    pop: () => tone(1200, 0.12, "triangle", 0.08, 0, 300),
    fanfare(rarity: string) {
      (fanfares[rarity] ?? [523, 659]).forEach((f, i) => tone(f, 0.22, "triangle", 0.06, i * 0.09));
    },
    dispose() {
      void ctx?.close();
      ctx = null;
    },
  };
}
