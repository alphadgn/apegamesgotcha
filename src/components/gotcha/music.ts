// Gotcha machine jukebox — music that plays while the machine spins.
//
// Five My Dead Friends tracks (the files in /public/music) are the only music. Each spin picks the next
// one from a shuffled bag (all five play before any repeats, never the same one twice in a row), and each
// is level-matched with trimDb so none is louder than the rest.
import { getMusicVolume, onMusicVolume, volumeGain } from "./sound";

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

function playClip(audio: HTMLAudioElement, url: string, level: number): Voice {
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

export function createJukebox(volume = 0.7) {
  let enabled = true;
  let current: Voice | null = null;
  let bag: number[] = [];
  let lastPlayed = -1;
  // The palm-tree volume slider: rescales the playing track.
  let currentLevel = 0;
  let player: HTMLAudioElement | null = null;
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
      player ??= new Audio();
      current = playClip(player, t.url, currentLevel * volumeGain(getMusicVolume()));
    },
    /** Fade the music out (never a hard cut). */
    stop(fade = 1) {
      current?.stop(fade);
      current = null;
    },
    dispose() {
      this.stop(0.2);
    },
  };
}

export const MUSIC_TRACKS = TRACKS.map((t) => ({ title: t.title, url: t.url, trimDb: t.trimDb }));
