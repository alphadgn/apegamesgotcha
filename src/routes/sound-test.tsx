// Sound check (not linked from the menu): open /sound-test on a phone and tap each button to see which way
// of playing music the device actually sounds, and whether the volume slider changes it.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { getMusicVolume, setMusicVolume } from "@/components/gotcha/sound";
import { createJukebox, type Jukebox, type MusicRoute } from "@/components/gotcha/music";

export const Route = createFileRoute("/sound-test")({
  head: () => ({ meta: [{ title: "Sound check — ApeGames Gotcha" }, { name: "robots", content: "noindex" }] }),
  component: SoundTest,
});

const TRACK = "/music/my-dead-friends.mp3";

function SoundTest() {
  const [log, setLog] = useState<string[]>([]);
  const [vol, setVol] = useState(1);
  const plain = useRef<HTMLAudioElement | null>(null);
  const boxes = useRef(new Map<MusicRoute, Jukebox>());
  const note = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 12));

  useEffect(() => setVol(getMusicVolume()), []);

  const stopAll = () => {
    plain.current?.pause();
    plain.current = null;
    boxes.current.forEach((b) => b.stop(0.3));
  };
  const jukebox = (route: MusicRoute) => {
    let b = boxes.current.get(route);
    if (!b) {
      b = createJukebox(0.7, route);
      boxes.current.set(route, b);
    }
    return b;
  };

  const tests: { label: string; help: string; run: () => void }[] = [
    {
      label: "1. Plain music file",
      help: "A normal audio player, nothing else.",
      run: () => {
        stopAll();
        const a = new Audio(TRACK);
        plain.current = a;
        a.play().then(
          () => note("1 playing"),
          (e: Error) => note(`1 failed: ${e.message}`),
        );
      },
    },
    {
      label: "2. Plain player",
      help: "Plays everywhere; on iPhone the slider can't change it.",
      run: () => {
        stopAll();
        jukebox("plain").start();
        note("2 started");
      },
    },
    {
      label: "3. Music through the sound engine",
      help: "The path that lets the slider work everywhere.",
      run: () => {
        stopAll();
        jukebox("engine").start();
        note("3 started");
      },
    },
    {
      label: "5. Game music (plain player, slider built in)",
      help: "What spins play now: plain player with the volume baked into the audio.",
      run: () => {
        stopAll();
        jukebox("rendered").start();
        note("5 started");
      },
    },
    {
      label: "4. Sound engine, unlocked for iPhone",
      help: "Same as 3, after asking iPhone for media playback.",
      run: () => {
        stopAll();
        jukebox("engine-unlocked").start();
        note("4 started");
      },
    },
  ];

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="rounded border border-border bg-background/90 p-5">
        <h1 className="text-2xl font-bold">Sound check</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap each button, then move the slider. Note which ones you hear and which ones the slider makes louder or
          quieter. Reload this page between tries.
        </p>
        <div className="mt-4 grid gap-3">
          {tests.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={t.run}
              className="rounded-lg px-4 py-3 text-left font-bold"
              style={{ background: "#f6c343", color: "#000" }}
            >
              {t.label}
              <span className="block text-xs font-normal">{t.help}</span>
            </button>
          ))}
          <label className="grid gap-1 text-sm">
            Music volume: {Math.round(vol * 100)}%
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(vol * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setVol(v);
                setMusicVolume(v);
              }}
            />
          </label>
          <button type="button" onClick={stopAll} className="rounded-lg border border-border px-4 py-2">
            Stop
          </button>
        </div>
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
