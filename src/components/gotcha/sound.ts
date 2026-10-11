// Shared audio for the Gotcha machine: one AudioContext for music and reveal effects.

let shared: AudioContext | null = null;

/**
 * One AudioContext for the whole page (iOS limits how many can exist). Call from a tap to unlock audio.
 *
 * The bug that silenced the music: this only woke the sound engine when it was "suspended". When the player
 * leaves the page (the Glyph sign-in tab, a wallet app, another app, the lock screen), iPhone Safari puts it in
 * a different state, "interrupted", and it stayed asleep for the rest of the visit. Now any state other than
 * "running" is woken inside the tap, and an interrupted or closed engine is replaced by a fresh one (a new
 * engine created inside a tap starts playing straight away).
 */
export function sharedAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const state = shared?.state as string | undefined;
  if (shared && (state === "interrupted" || state === "closed")) {
    void shared.close().catch(() => {});
    shared = null;
  }
  if (!shared) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    shared = new C();
  }
  if (shared.state !== "running") void shared.resume().catch(() => {});
  return shared;
}

/** A short silent WAV, for `unlockPlayback`. */
let silentUrl: string | null = null;
function silentWav() {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = rate / 2;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const text = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples * 2, true); // zeros = silence
  silentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrl;
}
let silentEl: HTMLAudioElement | null = null;

/**
 * Ask iOS to treat the page's sound engine like media playback (not "ambient" sound, which the phone can
 * mute): the "playback" audio session where Safari supports it, plus a silent looping plain audio player,
 * the long-standing way to do the same on any iOS version. Call from a tap, before `sharedAudio()`.
 */
export function unlockPlayback() {
  if (typeof window === "undefined") return;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
  } catch {
    /* not available */
  }
  if (!silentEl) {
    silentEl = new Audio(silentWav());
    silentEl.loop = true;
    silentEl.setAttribute("playsinline", "");
  }
  if (silentEl.paused) void silentEl.play().catch(() => {});
}

export type Sfx = ReturnType<typeof createSfx>;

// The reveal effects are short tones rendered once into small WAV files and played with a plain audio
// player (like the music), so iPhones play them with the ringer switch on silent too; the Web Audio engine
// is muted there.
type Note = { f: number; at: number; dur: number; vol: number; slideTo?: number };
const RATE = 22_050;
function renderWav(notes: Note[]) {
  const end = Math.max(...notes.map((n) => n.at + n.dur)) + 0.05;
  const len = Math.ceil(end * RATE);
  const pcm = new Float32Array(len);
  for (const n of notes) {
    const start = Math.floor(n.at * RATE);
    const count = Math.floor(n.dur * RATE);
    let phase = 0;
    for (let k = 0; k < count && start + k < len; k++) {
      const t = k / count;
      const f = n.slideTo ? n.f * Math.pow(n.slideTo / n.f, t) : n.f;
      phase += f / RATE;
      const tri = 1 - 4 * Math.abs((phase % 1) - 0.5); // triangle wave
      const env = Math.min(1, k / (0.01 * RATE)) * Math.pow(0.0001, t); // 10 ms attack, exponential decay
      pcm[start + k] = (pcm[start + k] ?? 0) + tri * env * n.vol;
    }
  }
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const text = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, len * 2, true);
  for (let k = 0; k < len; k++) v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, pcm[k] ?? 0)) * 32767, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

const fanfares: Record<string, number[]> = {
  common: [523, 659],
  rare: [523, 659, 784],
  epic: [523, 659, 784, 1047],
  legendary: [523, 659, 784, 1047, 1319, 1568],
};
const sfxUrls = new Map<string, string>();
function sfxUrl(key: string) {
  let u = sfxUrls.get(key);
  if (!u) {
    const notes: Note[] =
      key === "pop"
        ? [{ f: 1200, at: 0, dur: 0.12, vol: 0.5, slideTo: 300 }]
        : (fanfares[key] ?? fanfares["common"]!).map((f, i) => ({ f, at: 0.05 + i * 0.09, dur: 0.22, vol: 0.35 }));
    u = renderWav(notes);
    sfxUrls.set(key, u);
  }
  return u;
}

/** Short effects for the prize reveal. The spin itself is scored by the jukebox (music.ts). */
export function createSfx() {
  let enabled = true;
  // One player per effect, unlocked inside the Click To Spin tap (prime) so phones let it play later,
  // when the capsule opens.
  const players = new Map<string, HTMLAudioElement>();
  const player = (key: string) => {
    let a = players.get(key);
    if (!a) {
      a = new Audio(sfxUrl(key));
      a.preload = "auto";
      a.volume = 0.6;
      players.set(key, a);
    }
    return a;
  };
  const play = (key: string) => {
    if (!enabled || typeof window === "undefined") return;
    try {
      const a = player(key);
      a.muted = false;
      a.currentTime = 0;
      void a.play().catch(() => {});
    } catch {
      /* audio unavailable */
    }
  };
  return {
    setEnabled(v: boolean) {
      enabled = v;
    },
    /** Call from the tap: unlocks every effect for playing later. */
    prime() {
      if (!enabled || typeof window === "undefined") return;
      for (const key of ["pop", ...Object.keys(fanfares)]) {
        try {
          const a = player(key);
          if (!a.paused) continue;
          a.muted = true;
          void a
            .play()
            .then(() => {
              a.pause();
              a.currentTime = 0;
              a.muted = false;
            })
            .catch(() => {
              a.muted = false;
            });
        } catch {
          /* audio unavailable */
        }
      }
    },
    pop: () => play("pop"),
    fanfare: (rarity: string) => play(rarity in fanfares ? rarity : "common"),
  };
}

// ---- Music volume (the slider on the left palm tree) ----
// Only a number: the jukebox applies it to the playing track's own gain, so the audio path stays as it was.
// New key: starts everyone back at full volume (the music's original loudness); the old setting is ignored.
const VOLUME_KEY = "gm-music-volume-v2";
let volume = (() => {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
})();
const volumeListeners = new Set<(v: number) => void>();

/** Music volume from 0 (silent) to 1 (loudest). */
export function getMusicVolume() {
  return volume;
}

/** Gain for a slider position: the top is the original loudness, the bottom is off. */
export const volumeGain = (v: number) => v;

export function setMusicVolume(v: number) {
  if (!Number.isFinite(v)) return;
  volume = Math.min(1, Math.max(0, v));
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
