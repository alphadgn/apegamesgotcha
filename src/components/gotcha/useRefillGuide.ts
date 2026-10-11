import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Out of spins: Click To Spin points the player at the Refill button — it scrolls into view, takes focus
 * and pulses a few times (`attention` adds the `is-refill-attention` class).
 */
export function useRefillGuide() {
  const ref = useRef<HTMLButtonElement>(null);
  const [attention, setAttention] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const guide = useCallback(() => {
    const button = ref.current;
    if (!button) return;
    window.clearTimeout(timer.current);
    setAttention(false);
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      button.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      button.focus({ preventScroll: true });
      setAttention(true);
      timer.current = window.setTimeout(() => setAttention(false), 1800);
    });
  }, []);

  const clear = useCallback(() => setAttention(false), []);
  return { ref, attention, guide, clear };
}
