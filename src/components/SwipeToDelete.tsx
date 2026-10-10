import { useRef, useState, type ReactNode } from "react";
import { motion, animate, useMotionValue } from "motion/react";
import { Button } from "@/components/ui/button";

/** Keep the gesture surface stationary while only the foreground follows the finger. */
export function SwipeToDelete({ enabled, onDelete, label, children }: {
  enabled: boolean; onDelete: () => Promise<boolean>; label: string; children: ReactNode;
}) {
  const x = useMotionValue(0);
  const [pending, setPending] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; offset: number; axis: "x" | "y" | null } | null>(null);
  const running = useRef(false);
  const reveal = 144;
  const snap = (value: number) => animate(x, value, { duration: 0.18, ease: "easeOut" });
  const remove = async () => {
    if (!enabled || running.current) return;
    running.current = true;
    setPending(true);
    await snap(-reveal);
    try { await onDelete(); } finally {
      snap(0);
      running.current = false;
      setPending(false);
    }
  };
  const cancel = () => { gesture.current = null; snap(0); };
  return (
    <li className="relative isolate touch-pan-y overflow-hidden select-none"
      onPointerDown={(event) => {
        if (!enabled || running.current || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        x.stop();
        gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: x.get(), axis: null };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const g = gesture.current;
        if (!g || g.id !== event.pointerId) return;
        const dx = event.clientX - g.x, dy = event.clientY - g.y;
        if (!g.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 6) g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (g.axis === "x") x.set(Math.max(-reveal, Math.min(0, g.offset + dx)));
      }}
      onPointerUp={(event) => {
        const g = gesture.current;
        if (!g || g.id !== event.pointerId) return;
        gesture.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (g.axis === "x" && x.get() <= -reveal * 0.65) void remove();
        else snap(x.get() < -32 ? -reveal : 0);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (gesture.current) cancel(); }}
    >
      {enabled && <Button variant="destructive" disabled={pending} onClick={() => void remove()}
        className="absolute inset-y-0 right-0 h-full w-36 rounded-none whitespace-normal px-3 text-xs"
        aria-label={label}>{pending ? "Deleting…" : label}</Button>}
      <motion.div className="relative bg-card" style={{ x }}>
        {children}
      </motion.div>
    </li>
  );
}