// Signs a player out after 5 minutes without any activity (tap, click, key, scroll). After 4 quiet minutes a
// "Still there?" warning counts down the last minute; any activity — or its button — keeps them signed in.
// Activity in any open tab of the site counts (shared through localStorage), so a second tab left open doesn't
// sign out a player who's busy in the first. It ends the session in this browser only (not on other devices).
// Signed-out visitors are not affected.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SIGN_OUT_NOTICE_KEY, signOutEverywhere } from "@/lib/sign-out";

export const INACTIVITY_LIMIT_MS = 5 * 60_000;
const WARN_BEFORE_MS = 60_000;
const LAST_ACTIVE_KEY = "gm-last-active";
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

function readLastActive() {
  try {
    const v = Number(localStorage.getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

export function InactivityGuard() {
  const { user } = useAuth();
  const signedIn = !!user;
  const last = useRef(0);
  const lastWrite = useRef(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // The notice after an automatic sign-out (the page reloads to the home page).
  useEffect(() => {
    try {
      const n = sessionStorage.getItem(SIGN_OUT_NOTICE_KEY);
      if (n) {
        sessionStorage.removeItem(SIGN_OUT_NOTICE_KEY);
        window.setTimeout(() => toast.info(n, { duration: 8000 }), 400);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  // A fresh sign-in starts the clock now (an old timestamp from an earlier visit must not count).
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") mark(true);
    });
    return () => data.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mark = (force = false) => {
    const now = Date.now();
    last.current = now;
    if (force || now - lastWrite.current > 5000) {
      lastWrite.current = now;
      try {
        localStorage.setItem(LAST_ACTIVE_KEY, String(now));
      } catch {
        /* storage unavailable: this tab still keeps its own clock */
      }
    }
  };

  useEffect(() => {
    if (!signedIn) {
      setSecondsLeft(null);
      return;
    }
    // Coming back to the site after a long break (page reopened) counts from the last activity anywhere.
    last.current = Math.max(readLastActive(), last.current) || Date.now();
    if (!readLastActive()) mark(true);

    const onActivity = () => mark();
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true });

    const tick = () => {
      const idle = Date.now() - Math.max(last.current, readLastActive());
      if (idle >= INACTIVITY_LIMIT_MS) {
        window.clearInterval(t);
        setSecondsLeft(null);
        void signOutEverywhere({
          scope: "local",
          notice: "You were signed out after 5 minutes without activity. Sign in again to keep playing.",
        });
        return;
      }
      const left = INACTIVITY_LIMIT_MS - idle;
      setSecondsLeft(left <= WARN_BEFORE_MS ? Math.ceil(left / 1000) : null);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    // Phones pause timers in the background: check straight away when the page is shown again.
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  if (secondsLeft === null) return null;
  const m = Math.floor(secondsLeft / 60);
  const s = String(secondsLeft % 60).padStart(2, "0");
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
      aria-describedby="idle-desc"
    >
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center" style={{ borderColor: "#f6c34366" }}>
        <h2 id="idle-title" className="text-2xl font-bold">
          Still there?
        </h2>
        <p id="idle-desc" className="mt-2 text-muted-foreground">
          For your security you'll be signed out in{" "}
          <b className="text-foreground" aria-live="polite">
            {m}:{s}
          </b>{" "}
          because there's been no activity.
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => {
            mark(true);
            setSecondsLeft(null);
          }}
          className="mt-5 min-h-12 w-full rounded-lg px-4 py-2 text-base font-bold"
          style={{ backgroundColor: "#f6c343", color: "#141414" }}
        >
          Stay signed in
        </button>
        <button
          type="button"
          onClick={() => void signOutEverywhere({ scope: "local" })}
          className="mt-2 text-sm underline text-muted-foreground"
        >
          Sign out now
        </button>
      </div>
    </div>
  );
}
