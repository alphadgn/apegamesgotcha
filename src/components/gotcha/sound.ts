// Shared audio for the Gotcha machine: one AudioContext for music and reveal effects.

let shared: AudioContext | null = null;

/** The page's one AudioContext (iOS limits how many can exist), without unlocking it. Safe to call
 *  before any tap: music is decoded ahead of time on it, and plays once a tap unlocks it. */
export function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!shared) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    shared = new C({ latencyHint: "interactive" });
  }
  return shared;
}

/** The shared AudioContext, unlocked. Call from a tap so mobile browsers allow audio. */
export function sharedAudio(): AudioContext | null {
  const ctx = audioContext();
  if (ctx && ctx.state !== "running") void ctx.resume();
  return ctx;
}

export type Sfx = ReturnType<typeof createSfx>;

/** Short effects for the prize reveal. The spin itself is scored by the jukebox (music.ts). */
export function createSfx() {
  let enabled = true;

  const tone = (freq: number, dur: number, type: OscillatorType = "triangle", vol = 0.05, delay = 0, slideTo?: number) => {
    const a = enabled ? sharedAudio() : null;
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
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
    pop: () => tone(1200, 0.12, "triangle", 0.07, 0, 300),
    fanfare(rarity: string) {
      (fanfares[rarity] ?? [523, 659]).forEach((f, i) => tone(f, 0.22, "triangle", 0.05, 0.05 + i * 0.09));
    },
  };
}
