// Gotcha machine jukebox — music that plays while the machine spins.
//
// Five My Dead Friends tracks (the files in /public/music) are the only music. Each spin picks the next
// one from a shuffled bag (all five play before any repeats, never the same one twice in a row), and each
// is level-matched with trimDb so none is louder than the rest.
//
// Playback is the original path that played on iPhones: an <audio> element started inside the Click To Spin
// tap, routed through a gain node to the speakers. (A later version played pre-decoded AudioBuffers instead,
// and iPhones stayed silent: an <audio> element playing is what lets Safari sound the page's audio.)
// To start instantly, the five small files are downloaded when a machine appears and played from memory.
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

/** Fade-in at the start of a track: just long enough to avoid a click, short enough to feel instant. */
const ATTACK_S = 0.05;

type Voice = { setLevel: (gain: number) => void; stop: (fade: number) => void };

// The files are small (about 1.6 MB for all five): fetched once when a machine appears and kept in memory
// as blob: links, so a tap starts the track without waiting for the network.
const blobUrls = new Map<string, string>();
const loading = new Set<string>();
function preload(url: string) {
  if (typeof window === "undefined" || blobUrls.has(url) || loading.has(url)) return;
  loading.add(url);
  void fetch(url)
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => {
      if (b && b.size > 0) blobUrls.set(url, URL.createObjectURL(b));
    })
    .catch(() => undefined)
    .finally(() => loading.delete(url));
}

/** The original playback: <audio> → gain → speakers, started inside the tap. */
function playClip(ctx: AudioContext, url: string, level: number): Voice {
  const audio = new Audio(blobUrls.get(url) ?? url);
  audio.loop = true;
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");
  const src = ctx.createMediaElementSource(audio);
  const master = ctx.createGain();
  const now = ctx.currentTime;
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(level, now + ATTACK_S);
  src.connect(master).connect(ctx.destination);
  void audio.play().catch(() => {});
  let stopped = false;
  return {
    setLevel(gain) {
      if (stopped) return;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(gain, ctx.currentTime, 0.03);
    },
    stop(fade: number) {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t);
      master.gain.linearRampToValueAtTime(0, t + fade); // linear = a smooth, audible fade, not a drop-off
      window.setTimeout(() => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        try {
          master.disconnect();
        } catch {
          /* already gone */
        }
      }, fade * 1000 + 120);
    },
  };
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
  let current: { voice: Voice; base: number } | null = null;
  let bag: number[] = [];
  let lastPlayed = -1;

  const nextIndex = (count: number) => {
    if (!bag.length) {
      bag = shuffle(Array.from({ length: count }, (_, i) => i));
      if (bag.length > 1 && bag[0] === lastPlayed) bag.push(bag.shift()!); // never the same track twice in a row
    }
    lastPlayed = bag.shift()!;
    return lastPlayed;
  };

  // Download every track straight away (small files) so the first tap starts at once.
  if (typeof window !== "undefined") TRACKS.forEach((t) => preload(t.url));

  // The volume slider on the left palm tree: applies to the playing track immediately.
  onMusicVolume((v) => current?.voice.setLevel(current.base * volumeGain(v)));

  return {
    setEnabled(v: boolean) {
      enabled = v;
      if (!v) this.stop(0.3);
    },
    get playing() {
      return current !== null;
    },
    /** Start the next track. Call from a tap/click so mobile browsers allow audio. */
    start() {
      if (!enabled) return;
      const ctx = sharedAudio();
      if (!ctx) return;
      current?.voice.stop(0.4);
      const t = TRACKS[nextIndex(TRACKS.length)]!;
      const base = volume * dbToGain(t.trimDb);
      current = { voice: playClip(ctx, t.url, base * volumeGain(getMusicVolume())), base };
    },
    /** Fade the music out (never a hard cut). */
    stop(fade = 1) {
      current?.voice.stop(fade);
      current = null;
    },
    /** Stop playing (the machine left the page). The jukebox stays usable if the machine comes back. */
    dispose() {
      this.stop(0.2);
    },
  };
}

export const MUSIC_TRACKS = TRACKS.map((t) => ({ title: t.title, url: t.url, trimDb: t.trimDb }));
