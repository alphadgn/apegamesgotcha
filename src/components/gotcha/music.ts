// Gotcha machine jukebox — party music that plays while the machine spins.
//
// Built-in: six ORIGINAL instrumental tracks in 80s / 90s / 2000s party styles, synthesized live with
// WebAudio (no files, nothing to license), plus the featured clip(s) below. Each spin picks the next
// track from one shuffled bag, and every track is level-matched (trimDb) so none is louder than the rest.
//
// Licensed clips: drop audio files you have the rights to into /public/music and list them in
// /public/music/tracks.json, e.g. ["/music/clip-1.mp3", "/music/clip-2.mp3"]. When that list exists,
// the jukebox shuffles only those clips instead of the built-in tracks + featured clips.
import { sharedAudio } from "./sound";

type Era = "80s" | "90s" | "2000s";
type Step = string; // 16 chars per bar: "x" hit, "." rest
type Track = {
  title: string;
  era: Era;
  bpm: number;
  swing?: number; // 0..0.3 — delays every second 16th
  chords: string[]; // one per bar, loops
  kick: Step;
  snare?: Step;
  clap?: Step;
  hat?: Step;
  ohat?: Step;
  bass: Step; // r = root, o = octave up, f = fifth, . = rest
  bassWave: OscillatorType;
  stab?: Step;
  stabWave?: OscillatorType;
  pad?: boolean;
  arp?: "up" | "updown";
  arpWave?: OscillatorType;
  hook?: (number | null)[]; // 32 steps (2 bars), semitones above the key root, null = rest
  hookWave?: OscillatorType;
  key: string; // e.g. "A" — hook offsets are relative to this (octave 4)
  pump?: boolean; // sidechain-style pumping on the pads
  gatedSnare?: boolean; // big 80s snare
  /** Loudness trim so every track plays at the same level (measured RMS → target, see LEVEL_TARGET_DB). */
  trimDb?: number;
};

/**
 * Loudness target for the jukebox, as RMS in dBFS at full volume. Built-in tracks were rendered offline and
 * measured (Oct 2026): -20.2, -19.7, -17.4, -17.4, -17.7, -19.0 dB; each gets a trim to this target.
 */
const LEVEL_TARGET_DB = -18.5;

/** Audio files mixed into the shuffle with the built-in tracks (served from /public/music). */
const FEATURED_CLIPS: { title: string; url: string; trimDb: number }[] = [
  // Measured mean -14.4 dB (ffmpeg volumedetect) → -4.1 dB trim to sit level with the built-in tracks.
  { title: "My Dead Friends (fade)", url: "/music/my-dead-friends.mp3", trimDb: LEVEL_TARGET_DB - -14.4 },
  // Same artist. Levels measured against the clip above over the same window (ffmpeg astats RMS):
  // 2 is 0.94 dB quieter, 3 is 0.75 dB, 4 is 0.33 dB, 5 is 1.5 dB — trimmed up by that much.
  { title: "My Dead Friends II (fade)", url: "/music/my-dead-friends-2.mp3", trimDb: LEVEL_TARGET_DB - -15.35 },
  { title: "My Dead Friends III (fade)", url: "/music/my-dead-friends-3.mp3", trimDb: LEVEL_TARGET_DB - -15.15 },
  { title: "My Dead Friends IV (fade)", url: "/music/my-dead-friends-4.mp3", trimDb: LEVEL_TARGET_DB - -14.75 },
  { title: "My Dead Friends V (fade)", url: "/music/my-dead-friends-5.mp3", trimDb: LEVEL_TARGET_DB - -15.9 },
];

const dbToGain = (db: number | undefined) => Math.pow(10, (db ?? 0) / 20);

// ---------------------------------------------------------------- the tracks (all original)
const TRACKS: Track[] = [
  {
    title: "Neon Arcade", trimDb: LEVEL_TARGET_DB - -20.2,
    era: "80s",
    bpm: 118,
    key: "A",
    chords: ["Am", "F", "C", "G"],
    kick: "x.......x.......",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "r.r.o.r.r.r.o.r.",
    bassWave: "sawtooth",
    pad: true,
    arp: "up",
    arpWave: "square",
    gatedSnare: true,
  },
  {
    title: "Miami Nights Drive", trimDb: LEVEL_TARGET_DB - -19.7,
    era: "80s",
    bpm: 108,
    key: "D",
    chords: ["Dm", "Bb", "F", "C"],
    kick: "x.......x.......",
    snare: "....x.......x...",
    hat: "xxxxxxxxxxxxxxxx",
    bass: "rrrrrrrrrrrrrrrr",
    bassWave: "sawtooth",
    stab: "..x...x...x..x..",
    stabWave: "sawtooth",
    pad: true,
    hook: [7, null, 5, null, 3, null, 2, null, 3, null, null, null, 0, null, null, null, 7, null, 10, null, 9, null, 7, null, 5, null, null, null, 3, null, 2, null],
    hookWave: "sawtooth",
    gatedSnare: true,
  },
  {
    title: "Rave Signal", trimDb: LEVEL_TARGET_DB - -17.35,
    era: "90s",
    bpm: 126,
    key: "E",
    chords: ["Em", "C", "G", "D"],
    kick: "x...x...x...x...",
    clap: "....x.......x...",
    hat: "..x...x...x...x.",
    ohat: "..x...x...x...x.",
    bass: "..o...o...o...o.",
    bassWave: "square",
    stab: "x..x..x...x..x..",
    stabWave: "triangle",
    pad: false,
  },
  {
    title: "Hands Up Saturday", trimDb: LEVEL_TARGET_DB - -17.4,
    era: "90s",
    bpm: 134,
    key: "A",
    chords: ["Am", "F", "G", "Em"],
    kick: "x...x...x...x...",
    clap: "....x.......x...",
    ohat: "..x...x...x...x.",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "..r...r...r..rr.",
    bassWave: "sawtooth",
    pad: true,
    hook: [12, null, 12, 15, null, 12, null, 10, null, 7, null, null, 7, null, 10, null, 12, null, 12, 15, null, 17, null, 15, null, 12, null, null, 10, null, 7, null],
    hookWave: "square",
  },
  {
    title: "Millennium Bounce", trimDb: LEVEL_TARGET_DB - -17.65,
    era: "2000s",
    bpm: 128,
    key: "F",
    chords: ["Fm", "Db", "Ab", "Eb"],
    kick: "x...x...x...x...",
    clap: "....x.......x...",
    hat: "..x...x...x...x.",
    ohat: "......x.......x.",
    bass: "..r...r...r...r.",
    bassWave: "sawtooth",
    pad: true,
    pump: true,
    arp: "updown",
    arpWave: "sawtooth",
  },
  {
    title: "Y2K Rooftop", trimDb: LEVEL_TARGET_DB - -19.0,
    era: "2000s",
    bpm: 122,
    swing: 0.16,
    key: "C",
    chords: ["Cm", "Ab", "Eb", "Bb"],
    kick: "x.....x...x.....",
    snare: "....x.......x...",
    hat: "x.xxx.xxx.xxx.xx",
    bass: "r.....r.r.....o.",
    bassWave: "triangle",
    stab: "...x.....x...x..",
    stabWave: "square",
    pad: true,
    pump: true,
    hook: [15, null, 14, null, 12, null, null, 10, null, 12, null, null, null, null, null, null, 15, null, 17, null, 15, null, 14, null, 12, null, null, null, 10, null, null, null],
    hookWave: "triangle",
  },
];

const NOTE: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function chordNotes(name: string) {
  const m = /^([A-G][b#]?)(m?)$/.exec(name);
  let root = 48 + (NOTE[m?.[1] ?? "C"] ?? 0);
  if (root < 52) root += 12; // keep chords in a warm mid range
  const minor = m?.[2] === "m";
  return { root, notes: [root, root + (minor ? 3 : 4), root + 7] };
}

// ---------------------------------------------------------------- engine

type Voice = { master: GainNode; stop: (fade: number) => void };

function playTrack(ctx: BaseAudioContext, track: Track, volume: number): Voice {
  // master = fade envelope (into the compressor); out = player volume × level trim (after it), so the
  // measured trims stay exact at any volume.
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 0.35);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  const out = ctx.createGain();
  out.gain.value = volume * dbToGain(track.trimDb);
  master.connect(comp).connect(out).connect(ctx.destination);

  // reverb send (generated impulse — no files)
  const verb = ctx.createConvolver();
  const len = Math.floor(ctx.sampleRate * 1.6);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  verb.buffer = ir;
  const verbGain = ctx.createGain();
  verbGain.gain.value = 0.22;
  verb.connect(verbGain).connect(master);

  // echo for leads
  const delay = ctx.createDelay(1);
  delay.delayTime.value = (60 / track.bpm) * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.28;
  const delayOut = ctx.createGain();
  delayOut.gain.value = 0.25;
  delay.connect(fb).connect(delay);
  delay.connect(delayOut).connect(master);

  // pad bus (pumped in 2000s tracks)
  const padBus = ctx.createGain();
  padBus.connect(master);
  padBus.connect(verb);

  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const env = (g: GainNode, t: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  const noiseHit = (t: number, type: BiquadFilterType, freq: number, peak: number, decay: number, out: AudioNode = master) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    env(g, t, peak, 0.002, decay);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + decay + 0.05);
  };
  const synth = (t: number, midi: number, dur: number, wave: OscillatorType, peak: number, cutoff: number, out: AudioNode, detune = 0) => {
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = hz(midi);
    o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.35), t + dur);
    const g = ctx.createGain();
    env(g, t, peak, 0.005, dur);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  const kick = (t: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    env(g, t, 0.9, 0.002, 0.32);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.4);
    if (track.pump) {
      padBus.gain.cancelScheduledValues(t);
      padBus.gain.setValueAtTime(0.25, t);
      padBus.gain.linearRampToValueAtTime(1, t + 0.24);
    }
  };
  const snare = (t: number) => {
    noiseHit(t, "bandpass", 1800, track.gatedSnare ? 0.55 : 0.4, track.gatedSnare ? 0.26 : 0.16);
    if (track.gatedSnare) noiseHit(t, "bandpass", 1600, 0.35, 0.3, verb);
    synth(t, 55, 0.09, "triangle", 0.25, 2000, master);
  };
  const clap = (t: number) => {
    for (let i = 0; i < 3; i++) noiseHit(t + i * 0.011, "bandpass", 1300, 0.35, 0.03);
    noiseHit(t + 0.033, "bandpass", 1200, 0.4, 0.16);
    noiseHit(t + 0.033, "bandpass", 1200, 0.2, 0.2, verb);
  };

  const sixteenth = 60 / track.bpm / 4;
  const keyRoot = 60 + (NOTE[track.key] ?? 0);
  let step = 0;
  let next = ctx.currentTime + 0.06;

  const playStep = (s: number, t: number) => {
    const bar = Math.floor(s / 16);
    const i = s % 16;
    const { root, notes } = chordNotes(track.chords[bar % track.chords.length] ?? "C");
    const hit = (p?: Step) => p?.[i] === "x";

    if (hit(track.kick)) kick(t);
    if (hit(track.snare)) snare(t);
    if (hit(track.clap)) clap(t);
    if (hit(track.hat)) noiseHit(t, "highpass", 8000, 0.12, 0.035);
    if (hit(track.ohat)) noiseHit(t, "highpass", 7000, 0.1, 0.18);

    const b = track.bass[i];
    if (b && b !== ".") {
      const bassRoot = root - 24 + (b === "o" ? 12 : b === "f" ? 7 : 0);
      synth(t, bassRoot, sixteenth * 1.6, track.bassWave, 0.32, 900, master);
    }
    if (track.pad && i === 0) {
      for (const n of notes) {
        synth(t, n, sixteenth * 15, "sawtooth", 0.035, 2400, padBus, -7);
        synth(t, n, sixteenth * 15, "sawtooth", 0.035, 2400, padBus, 7);
      }
    }
    if (hit(track.stab)) for (const n of notes) synth(t, n + 12, 0.16, track.stabWave ?? "square", 0.05, 3200, master);
    if (track.arp && i % 2 === 0) {
      const seq = track.arp === "up" ? [0, 1, 2, 1 + 2] : [0, 1, 2, 3, 2, 1];
      const k = seq[(i / 2) % seq.length] ?? 0;
      const n = (notes[k % 3] ?? root) + 12 + (k >= 3 ? 12 : 0);
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(master);
      g.connect(delay);
      synth(t, n, sixteenth * 1.5, track.arpWave ?? "square", 0.05, 3500, g);
    }
    if (track.hook) {
      const h = track.hook[s % track.hook.length];
      if (h != null) {
        const g = ctx.createGain();
        g.connect(master);
        g.connect(delay);
        synth(t, keyRoot + h, sixteenth * 1.9, track.hookWave ?? "square", 0.06, 4000, g);
      }
    }
  };

  const scheduleUntil = (until: number) => {
    while (next < until) {
      const swing = step % 2 === 1 ? (track.swing ?? 0) * sixteenth : 0;
      playStep(step, next + swing);
      next += sixteenth;
      step++;
    }
  };
  // Offline rendering (tests/previews) schedules everything up front; live playback looks ahead 140ms.
  const isOffline = typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
  if (isOffline) scheduleUntil((ctx as OfflineAudioContext).length / ctx.sampleRate);
  const timer = isOffline ? 0 : window.setInterval(() => scheduleUntil(ctx.currentTime + 0.14), 25);

  let stopped = false;
  return {
    master,
    stop(fade: number) {
      if (stopped) return;
      stopped = true;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
      master.gain.linearRampToValueAtTime(0, now + fade); // linear = a smooth, audible fade, not a drop-off
      window.setTimeout(() => {
        clearInterval(timer);
        try {
          master.disconnect();
          out.disconnect();
        } catch {
          /* already gone */
        }
      }, fade * 1000 + 120);
    },
  };
}

function playClip(ctx: AudioContext, url: string, volume: number, trimDb = 0): Voice {
  volume *= dbToGain(trimDb);
  const audio = new Audio(url);
  audio.loop = true;
  audio.crossOrigin = "anonymous";
  const src = ctx.createMediaElementSource(audio);
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.35);
  src.connect(master).connect(ctx.destination);
  void audio.play().catch(() => {});
  let stopped = false;
  return {
    master,
    stop(fade: number) {
      if (stopped) return;
      stopped = true;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
      master.gain.linearRampToValueAtTime(0, now + fade); // linear = a smooth, audible fade, not a drop-off
      window.setTimeout(() => {
        audio.pause();
        audio.src = "";
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
  let current: Voice | null = null;
  let clips: string[] = [];
  let bag: number[] = [];
  let lastPlayed = -1;
  let manifestRequested = false;

  const nextIndex = (count: number) => {
    if (!bag.length) {
      bag = shuffle(Array.from({ length: count }, (_, i) => i));
      if (bag.length > 1 && bag[0] === lastPlayed) bag.push(bag.shift()!); // never the same track twice in a row
    }
    lastPlayed = bag.shift()!;
    return lastPlayed;
  };

  return {
    /** Look for licensed clips in /public/music/tracks.json (optional). */
    preload() {
      if (manifestRequested || typeof fetch === "undefined") return;
      manifestRequested = true;
      fetch("/music/tracks.json", { cache: "force-cache" })
        .then((r) => (r.ok ? r.json() : []))
        .then((list: unknown) => {
          if (Array.isArray(list)) {
            clips = list.filter((x): x is string => typeof x === "string" && x.length > 0);
            bag = [];
          }
        })
        .catch(() => {});
    },
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
      const ctx = sharedAudio();
      if (!ctx) return;
      current?.stop(0.4);
      if (clips.length) {
        current = playClip(ctx, clips[nextIndex(clips.length)]!, volume);
        return;
      }
      // One shuffled bag: the built-in tracks followed by the featured clips.
      const i = nextIndex(TRACKS.length + FEATURED_CLIPS.length);
      const featured = FEATURED_CLIPS[i - TRACKS.length];
      current = featured ? playClip(ctx, featured.url, volume, featured.trimDb) : playTrack(ctx, TRACKS[i]!, volume);
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

export const BUILT_IN_TRACKS = TRACKS.map((t) => ({ title: t.title, era: t.era, bpm: t.bpm }));
export const FEATURED_TRACKS = FEATURED_CLIPS.map((c) => ({ title: c.title, url: c.url, trimDb: c.trimDb }));

/** Render a built-in track into an OfflineAudioContext (used for previews and tests). */
export function renderBuiltInTrack(ctx: OfflineAudioContext, index: number, volume = 0.5) {
  const t = TRACKS[index % TRACKS.length];
  if (t) playTrack(ctx, t, volume);
}
