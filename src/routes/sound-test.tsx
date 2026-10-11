// Sound check (not linked from the menu): open /sound-test on a phone and tap each button to see which way
// of playing audio the device actually sounds. Used to pin down "no music" reports on a specific phone.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { sharedAudio } from "@/components/gotcha/sound";
import { createJukebox, type Jukebox } from "@/components/gotcha/music";

export const Route = createFileRoute("/sound-test")({
  head: () => ({ meta: [{ title: "Sound check — ApeGames Gotcha" }, { name: "robots", content: "noindex" }] }),
  component: SoundTest,
});

const TRACK = "/music/my-dead-friends.mp3";

function SoundTest() {
  const [log, setLog] = useState<string[]>([]);
  const [state, setState] = useState("not started");
  const plain = useRef<HTMLAudioElement | null>(null);
  const jukebox = useRef<Jukebox | null>(null);
  const note = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 12));

  useEffect(() => {
    const t = window.setInterval(() => {
      const ctx = (window as unknown as { __gmCtx?: AudioContext | undefined }).__gmCtx;
      if (ctx) setState(ctx.state);
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  const stopAll = () => {
    plain.current?.pause();
    plain.current = null;
    jukebox.current?.stop(0.3);
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
      label: "2. Game music (spin)",
      help: "Exactly what Click To Spin plays.",
      run: () => {
        stopAll();
        jukebox.current ??= createJukebox();
        jukebox.current.setEnabled(true);
        jukebox.current.start();
        const ctx = sharedAudio();
        (window as unknown as { __gmCtx?: AudioContext | undefined }).__gmCtx = ctx ?? undefined;
        note(`2 started (sound engine: ${ctx?.state ?? "unavailable"})`);
      },
    },
    {
      label: "3. Beep (game sound effects)",
      help: "The prize-reveal sound.",
      run: () => {
        const ctx = sharedAudio();
        (window as unknown as { __gmCtx?: AudioContext | undefined }).__gmCtx = ctx ?? undefined;
        if (!ctx) return note("3 failed: no sound engine");
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 660;
        g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.6);
        note(`3 beep (sound engine: ${ctx.state})`);
      },
    },
  ];

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="rounded border border-border bg-background/90 p-5">
        <h1 className="text-2xl font-bold">Sound check</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap each button and note which ones you hear. Phone volume up; try once with the ringer switch on and once
          on silent.
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
          <button type="button" onClick={stopAll} className="rounded-lg border border-border px-4 py-2">
            Stop
          </button>
        </div>
        <p className="mt-4 font-mono text-xs">Sound engine: {state}</p>
        <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
