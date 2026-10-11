// Gotcha machine jukebox — music that plays while the machine spins.
//
// Five My Dead Friends tracks (the files in /public/music) are the only music. Each spin picks the next
// one from a shuffled bag (all five play before any repeats, never the same one twice in a row), and each
// is level-matched with trimDb so none is louder than the rest.
import { getMusicVolume, onMusicVolume, relaxPlayback, sharedAudio, unlockPlayback, volumeGain } from "./sound";

/** Loudness target, as RMS in dBFS at full volume; each track's trim brings it to this level. */
const LEVEL_TARGET_DB = -18.5;

/** The only music the machine plays (served from /public/music), shuffled each spin. */
const TRACKS: { title: string; url: string; trimDb: number }[] = [
  // Measured mean -14.4 dB → -4.1 dB trim (the level the app's earlier music played at).
  { title: "My Dead Friends (fade)", url: "/music/my-dead-friends.mp3", trimDb: LEVEL_TARGET_DB - -14.4 },
  // Same artist. Levels measured against the clip above over the same window (ffmpeg astats RMS):
  // 2 is 0.94 dB quieter, 3 is 0.75 dB, 4 is 0.33 dB, 5 is 1.5 dB — trimmed up by that much.
  { title: "My Dead Friends II (fade)", url: "/music/my-dead-friends-2.mp3", trimDb: LEVEL_TARGET_DB - -15.35 },
  { title: "My Dead Friends III (fade)", url: "/music/my-dead-friends-3.mp3", trimDb: LEVEL_TARGET_DB - -15.15 },
  { title: "My Dead Friends IV (fade)", url: "/music/my-dead-friends-4.mp3", trimDb: LEVEL_TARGET_DB - -14.75 },
  { title: "My Dead Friends V (fade)", url: "/music/my-dead-friends-5.mp3", trimDb: LEVEL_TARGET_DB - -15.9 },
];

const dbToGain = (db: number | undefined) => Math.pow(10, (db ?? 0) / 20);

type Voice = { setLevel: (level: number) => void; stop: (fade: number) => void };

/**
 * A plain audio player, NOT routed through the Web Audio engine. On iPhones the Web Audio engine goes silent
 * when the ringer switch is on silent, while a plain audio player keeps playing (the /sound-test check:
 * "1. Plain music file" played on silent, "2. Game music" did not). Volume and fades use the player's own
 * volume (iPhones keep that at the phone's volume, so there the side buttons set the loudness).
 */
const plays = new WeakMap<HTMLAudioElement, number>();

function playPlain(audio: HTMLAudioElement, url: string, level: number): Voice {
  const token = (plays.get(audio) ?? 0) + 1; // a newer track on this player ends this one's fade
  plays.set(audio, token);
  const mine = () => plays.get(audio) === token;
  // One player per machine, reused for every track: once a tap has started it, phones let it play again
  // later without a tap (spin-all and reveal-all start the next track from a timer).
  audio.pause();
  audio.src = url;
  audio.loop = true;
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  audio.volume = clamp(level);
  void audio.play().catch(() => {});
  let stopped = false;
  let fader = 0;
  return {
    setLevel(v) {
      if (!stopped && mine()) audio.volume = clamp(v);
    },
    stop(fade: number) {
      if (stopped) return;
      stopped = true;
      const from = audio.volume;
      const steps = Math.max(1, Math.round((fade * 1000) / 50));
      let k = 0;
      fader = window.setInterval(() => {
        if (!mine()) return window.clearInterval(fader); // the next track took over this player
        k++;
        audio.volume = clamp(from * (1 - k / steps)); // a smooth fade where the browser allows it
        if (k >= steps) {
          window.clearInterval(fader);
          audio.pause();
        }
      }, 50);
    },
  };
}

/**
 * The original playback path (the one that played before): an <audio> player started inside the Click To
 * Spin tap, routed through the sound engine (`sharedAudio`) via a gain node, so the palm-tree slider and the
 * fades control the loudness. One player per machine, reused for every track: once a tap has started it, the
 * phone lets it play again later without a tap (spin-all and reveal-all start the next track from a timer).
 * If the sound engine had to be replaced (see `sharedAudio`), a fresh player is built on the new one.
 */
type Player = { ctx: AudioContext; audio: HTMLAudioElement; gain: GainNode; token: number };

function playerFor(ctx: AudioContext, old: Player | null): Player {
  if (old && old.ctx === ctx) return old;
  old?.audio.pause();
  const audio = new Audio();
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");
  const gain = ctx.createGain();
  gain.gain.value = 0;
  ctx.createMediaElementSource(audio).connect(gain).connect(ctx.destination);
  return { ctx, audio, gain, token: 0 };
}

function playEngine(p: Player, url: string, level: number): Voice {
  const token = ++p.token; // a newer track on this player ends this one's fade
  const { ctx, audio, gain } = p;
  audio.pause();
  audio.src = url;
  audio.loop = true;
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(level, now + 0.05);
  void audio.play().catch(() => {});
  let stopped = false;
  return {
    setLevel(v) {
      if (stopped || p.token !== token) return;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    },
    stop(fade: number) {
      if (stopped) return;
      stopped = true;
      if (p.token !== token) return; // the next track already took over this player
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
      gain.gain.linearRampToValueAtTime(0, t + fade); // a smooth, audible fade
      window.setTimeout(() => {
        if (p.token === token) audio.pause();
      }, fade * 1000 + 120);
    },
  };
}

// Warm the browser cache with the five small tracks as soon as a machine appears, so a tap starts quickly.
const warmed = new Set<string>();
function warm(url: string) {
  if (typeof window === "undefined" || warmed.has(url)) return;
  warmed.add(url);
  void fetch(url).catch(() => warmed.delete(url));
}

function shuffle<T>(xs: T[]) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export type Jukebox = ReturnType<typeof createJukebox>;

/**
 * How the music reaches the speakers:
 * - "plain" (the game's default): a plain <audio> player. Plays on every iPhone setting; iPhones ignore a web
 *   page's volume for it, so the palm-tree slider can't change it there.
 * - "engine": through the sound engine (gain node), so the slider works everywhere. On the owner's iPhone this
 *   was silent (screen recording 18:36: no music until the reveal sounds), so the game doesn't use it yet.
 * - "engine-unlocked": "engine" after asking iOS for media playback (`unlockPlayback`). Under test on /sound-test.
 */
export type MusicRoute = "plain" | "engine" | "engine-unlocked";

export function createJukebox(volume = 0.7, route: MusicRoute = "plain") {
  let enabled = true;
  let current: Voice | null = null;
  let bag: number[] = [];
  let lastPlayed = -1;
  // The palm-tree volume slider: rescales the playing track.
  let currentLevel = 0;
  let player: Player | null = null;
  let plainPlayer: HTMLAudioElement | null = null;
  let relaxTimer = 0;
  onMusicVolume((v) => current?.setLevel(currentLevel * volumeGain(v)));
  if (typeof window !== "undefined") TRACKS.forEach((t) => warm(t.url));

  const nextIndex = (count: number) => {
    if (!bag.length) {
      bag = shuffle(Array.from({ length: count }, (_, i) => i));
      if (bag.length > 1 && bag[0] === lastPlayed) bag.push(bag.shift()!); // never the same track twice in a row
    }
    lastPlayed = bag.shift()!;
    return lastPlayed;
  };

  return {
    setEnabled(v: boolean) {
      enabled = v;
      if (!v) this.stop(0.3);
    },
    get playing() {
      return current !== null;
    },
    /** Start a new random track. Call from a tap/click so mobile browsers allow audio. */
    start() {
      if (!enabled) return;
      current?.stop(0.4);
      const t = TRACKS[nextIndex(TRACKS.length)]!;
      currentLevel = volume * dbToGain(t.trimDb);
      const level = currentLevel * volumeGain(getMusicVolume());
      if (route === "plain") {
        plainPlayer ??= new Audio();
        current = playPlain(plainPlayer, t.url, level);
        return;
      }
      if (route === "engine-unlocked") unlockPlayback();
      const ctx = sharedAudio(); // wakes (or replaces) the sound engine inside the tap
      if (!ctx) return;
      player = playerFor(ctx, player);
      current = playEngine(player, t.url, level);
    },
    /** Fade the music out (never a hard cut). */
    stop(fade = 1) {
      if (!current) return;
      current.stop(fade);
      current = null;
      if (route === "engine-unlocked") {
        window.clearTimeout(relaxTimer);
        relaxTimer = window.setTimeout(() => {
          if (!current) relaxPlayback();
        }, fade * 1000 + 3000);
      }
    },
    dispose() {
      this.stop(0.2);
    },
  };
}

export const MUSIC_TRACKS = TRACKS.map((t) => ({ title: t.title, url: t.url, trimDb: t.trimDb }));
