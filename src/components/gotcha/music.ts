// Gotcha machine jukebox — music that plays while the machine spins.
//
// Five My Dead Friends tracks (the files in /public/music) are the only music. Each spin picks the next
// one from a shuffled bag (all five play before any repeats, never the same one twice in a row), and each
// is level-matched with trimDb so none is louder than the rest.
import { getMusicVolume, onMusicVolume, sharedAudio, volumeGain } from "./sound";

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

function playClip(p: Player, url: string, level: number): Voice {
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

export function createJukebox(volume = 0.7) {
  let enabled = true;
  let current: Voice | null = null;
  let bag: number[] = [];
  let lastPlayed = -1;
  // The palm-tree volume slider: rescales the playing track.
  let currentLevel = 0;
  let player: Player | null = null;
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
      const ctx = sharedAudio(); // wakes (or replaces) the sound engine inside the tap
      if (!ctx) return;
      current?.stop(0.4);
      const t = TRACKS[nextIndex(TRACKS.length)]!;
      currentLevel = volume * dbToGain(t.trimDb);
      player = playerFor(ctx, player);
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
