// Shared audio for the Gotcha machine: one AudioContext for music and reveal effects.

let shared: AudioContext | null = null;

/** One AudioContext for the whole page (iOS limits how many can exist). Call from a tap to unlock audio.
 *  (Restored to the version that played music on iPhones; see music.ts.) */
export function sharedAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!shared) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    shared = new C();
  }
  if (shared.state === "suspended") void shared.resume();
  return shared;
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

// ---- Music volume (the slider on the left palm tree) ----
// The jukebox listens (onMusicVolume) and sets each playing track's own gain, so the music keeps exactly
// the original audio path (media element → gain → speakers) and the slider still works mid-track.
const VOLUME_KEY = "gm-music-volume";
let volume = (() => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? Math.min(1, Math.max(0, v)) : 0.8;
  } catch {
    return 0.8;
  }
})();
const volumeListeners = new Set<(v: number) => void>();

/** Music volume from 0 (silent) to 1 (loudest). */
export function getMusicVolume() {
  return volume;
}

/** Gain for the slider position: squared, so the slider feels even to the ear. */
export const volumeGain = (v: number) => v * v;

export function setMusicVolume(v: number) {
  volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : volume;
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.round(volume * 100) / 100));
  } catch {
    /* storage unavailable */
  }
  volumeListeners.forEach((l) => l(volume));
}

export function onMusicVolume(l: (v: number) => void) {
  volumeListeners.add(l);
  return () => volumeListeners.delete(l);
}
