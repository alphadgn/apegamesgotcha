// Gotcha machine jukebox — music that plays while the machine spins.
//
// Five My Dead Friends tracks (the files in /public/music) are the only music. Each spin picks the next
// one from a shuffled bag (all five play before any repeats, never the same one twice in a row), and each
// is level-matched with trimDb so none is louder than the rest.
import { audioContext, sharedAudio } from "./sound";

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
const ATTACK_S = 0.03;

type Voice = { stop: (fade: number) => void };

/** Ramp a voice's gain down and release it — a smooth, audible fade, never a hard cut. */
function fadeOut(ctx: AudioContext, master: GainNode, fade: number, release: () => void) {
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
  master.gain.linearRampToValueAtTime(0, now + fade);
  window.setTimeout(() => {
    release();
    try {
      master.disconnect();
    } catch {
      /* already gone */
    }
  }, fade * 1000 + 120);
}

function gainFor(ctx: AudioContext, volume: number) {
  const master = ctx.createGain();
  const now = ctx.currentTime;
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(volume, now + ATTACK_S);
  master.connect(ctx.destination);
  return master;
}

/** Instant playback from a track already decoded in memory: sound starts in the same tap. */
function playBuffer(ctx: AudioContext, buffer: AudioBuffer, volume: number): Voice {
  const master = gainFor(ctx, volume);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(master);
  src.start();
  let stopped = false;
  return {
    stop(fade) {
      if (stopped) return;
      stopped = true;
      fadeOut(ctx, master, fade, () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      });
    },
  };
}

/** Fallback while a track is still loading (very first tap on a slow connection): stream it. */
function playStream(ctx: AudioContext, url: string, volume: number): Voice {
  const audio = new Audio(url);
  audio.loop = true;
  audio.preload = "auto";
  const master = gainFor(ctx, volume);
  ctx.createMediaElementSource(audio).connect(master);
  void audio.play().catch(() => {});
  let stopped = false;
  return {
    stop(fade) {
      if (stopped) return;
      stopped = true;
      fadeOut(ctx, master, fade, () => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      });
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

// The MP3 files are small (about 1.6 MB for all five), so they're downloaded once per page as soon as a
// machine appears, and kept compressed. Only the track that plays next is decoded ahead of time, so it
// can start the instant the player taps without holding every track's decoded audio in memory.
const fileCache = new Map<string, Promise<ArrayBuffer | null>>();
function fetchTrack(url: string) {
  let p = fileCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
    fileCache.set(url, p);
  }
  return p;
}

async function decodeTrack(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
  const bytes = await fetchTrack(url);
  if (!bytes) return null;
  try {
    // decodeAudioData takes ownership of the bytes, so decode a copy and keep the original for repeats.
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
}

export type Jukebox = ReturnType<typeof createJukebox>;

export function createJukebox(volume = 0.7) {
  let enabled = true;
  let current: Voice | null = null;
  let bag: number[] = [];
  let lastPlayed = -1;
  /** The track that plays on the next tap, decoded and ready (or still decoding). */
  let next: { index: number; buffer: AudioBuffer | null } | null = null;

  const nextIndex = (count: number) => {
    if (!bag.length) {
      bag = shuffle(Array.from({ length: count }, (_, i) => i));
      if (bag.length > 1 && bag[0] === lastPlayed) bag.push(bag.shift()!); // never the same track twice in a row
    }
    lastPlayed = bag.shift()!;
    return lastPlayed;
  };

  /** Pick the next track and decode it now, so the next tap plays it with no wait. */
  const prepare = () => {
    if (typeof window === "undefined") return;
    const ctx = audioContext();
    if (!ctx) return;
    const slot: { index: number; buffer: AudioBuffer | null } = { index: nextIndex(TRACKS.length), buffer: null };
    next = slot;
    void decodeTrack(ctx, TRACKS[slot.index]!.url).then((b) => {
      slot.buffer = b;
    });
  };

  // Download every track straight away (small files), and get the first one decoded.
  if (typeof window !== "undefined") {
    TRACKS.forEach((t) => void fetchTrack(t.url));
    prepare();
  }

  return {
    setEnabled(v: boolean) {
      enabled = v;
      if (!v) this.stop(0.3);
    },
    get playing() {
      return current !== null;
    },
    /** Start the next track — immediately. Call from a tap/click so mobile browsers allow audio. */
    start() {
      if (!enabled) return;
      const ctx = sharedAudio(); // resumes the audio context inside the tap
      if (!ctx) return;
      current?.stop(0.4);
      if (!next) prepare();
      const slot = next;
      if (!slot) return;
      const t = TRACKS[slot.index]!;
      const vol = volume * dbToGain(t.trimDb);
      current = slot.buffer ? playBuffer(ctx, slot.buffer, vol) : playStream(ctx, t.url, vol);
      prepare(); // decode the one after, ready for the next tap
    },
    /** Fade the music out (never a hard cut). */
    stop(fade = 1) {
      current?.stop(fade);
      current = null;
    },
    /** Stop playing (the machine left the page). The jukebox stays usable if the machine comes back. */
    dispose() {
      this.stop(0.2);
    },
  };
}

export const MUSIC_TRACKS = TRACKS.map((t) => ({ title: t.title, url: t.url, trimDb: t.trimDb }));
