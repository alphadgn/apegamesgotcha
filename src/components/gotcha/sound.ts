// Shared audio for the Gotcha machine: one AudioContext for music and reveal effects.

let shared: AudioContext | null = null;

type AudioCtor = typeof AudioContext;
type OfflineCtor = typeof OfflineAudioContext;

function realtimeCtor(): AudioCtor | undefined {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
}

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** A short silent WAV (for the iOS ringer-switch workaround below). */
let silentUrl: string | null = null;
function silentWav() {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = rate / 4; // 0.25 s
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const text = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit
  text(36, "data");
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128); // 8-bit silence
  silentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrl;
}
let silentEl: HTMLAudioElement | null = null;

/**
 * iPhones mute Web Audio when the ringer (silent) switch is on, so the spin music was inaudible even with
 * "Sound on". Ask for the "playback" audio session (Safari 16.4+), which plays like a music app; on older
 * iOS, a silent looping <audio> element started in the tap does the same.
 */
function claimPlaybackSession() {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) {
      if (nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
      return;
    }
  } catch {
    /* not settable here */
  }
  if (!isIOS()) return;
  if (!silentEl) {
    silentEl = new Audio(silentWav());
    silentEl.loop = true;
    silentEl.setAttribute("playsinline", "");
    silentEl.setAttribute("x-webkit-airplay", "deny");
  }
  if (silentEl.paused) void silentEl.play().catch(() => {});
}

/** Music stopped: hand the audio session back (other apps' audio may resume, lock screen shows nothing). */
export function releasePlaybackSession() {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession && nav.audioSession.type === "playback") nav.audioSession.type = "auto";
  } catch {
    /* ignore */
  }
  silentEl?.pause();
}

/** The page's one AudioContext (iOS limits how many can exist), if it already exists. Never creates one:
 *  iOS only lets a context play when it was created or resumed inside a tap (see `sharedAudio`). */
export function audioContext(): AudioContext | null {
  return shared;
}

/**
 * The shared AudioContext, created or woken up inside the player's tap so mobile browsers allow sound.
 * A context iOS left "interrupted" (after a call, another app, or the Glyph/wallet window) is replaced.
 */
export function sharedAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  claimPlaybackSession();
  const state = shared?.state as string | undefined;
  if (shared && (state === "closed" || state === "interrupted")) {
    void shared.close().catch(() => {});
    shared = null;
  }
  if (!shared) {
    const C = realtimeCtor();
    if (!C) return null;
    shared = new C({ latencyHint: "interactive" });
  }
  if (shared.state !== "running") void shared.resume().catch(() => {});
  return shared;
}

/** Decodes audio ahead of any tap without creating the playing context (decoded audio works in any context). */
let decoder: BaseAudioContext | null = null;
export function audioDecoder(): BaseAudioContext | null {
  if (typeof window === "undefined") return null;
  if (shared) return shared;
  if (!decoder) {
    const O =
      window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext;
    if (!O) return null;
    try {
      decoder = new O(2, 44_100, 44_100);
    } catch {
      return null;
    }
  }
  return decoder;
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
// All music plays through one gain node, so the slider changes it instantly, even mid-track.
const VOLUME_KEY = "gm-music-volume";
let bus: GainNode | null = null;
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

/** Where every music voice connects (instead of straight to the speakers). */
export function musicBus(ctx: AudioContext): AudioNode {
  if (!bus || bus.context !== ctx) {
    bus = ctx.createGain();
    bus.gain.value = volume * volume; // squared: the slider feels even to the ear
    bus.connect(ctx.destination);
  }
  return bus;
}

export function setMusicVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  if (bus) bus.gain.setTargetAtTime(volume * volume, bus.context.currentTime, 0.03);
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
