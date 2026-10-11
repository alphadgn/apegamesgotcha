// Music volume slider on the trunk of the left palm tree: the top of its travel is the loudest, the bottom
// is silent. Anyone can use it (signed in or not), before or during a spin. It sits next to the machine,
// lined up with the machine's parts: the top with the "Every draw powered by Chainlink VRF" pill, the bottom
// with the One spin / Spin all switch (the positions the design marked; no marks are drawn).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getMusicVolume, onMusicVolume, setMusicVolume } from "./sound";

type Spot = { x: number; top: number; height: number };

const THUMB = 26; // px, matches .gm-vol-thumb

/** Where the slider goes, in the machine root's coordinates (null until measured). */
function useSpot(selfRef: RefObject<HTMLDivElement | null>) {
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    const root = selfRef.current?.closest<HTMLElement>(".gm");
    if (!root) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const g = root.getBoundingClientRect();
        const pill = root.querySelector(".gm-plate-pill")?.getBoundingClientRect();
        const row = root.querySelectorAll(".gm-switch-row")[1]?.getBoundingClientRect();
        const palm = root.querySelector(".gm-palm-l");
        const body = root.querySelector(".gm-body")?.getBoundingClientRect();
        const session = root.querySelector(".gm-session")?.getBoundingClientRect();
        if (!pill || !row || !body || !(palm instanceof SVGGraphicsElement)) return setSpot(null);
        const p = palm.getBoundingClientRect();
        // The trunk runs up the middle of the palm drawing (x ≈ 100 of 200).
        let x = p.left + p.width * 0.5 - g.left;
        // Keep the whole knob beside the machine, never on it.
        x = Math.max(THUMB / 2 + 4, Math.min(x, body.left - g.left - THUMB / 2 - 4));
        let top = pill.top + pill.height / 2 - g.top;
        const bottom = row.top + row.height / 2 - g.top;
        // Wide screens: the "Your machine" card covers the top of the trunk, so start just below it.
        if (session && session.right - g.left > x - THUMB && session.top - g.top < bottom)
          top = Math.max(top, session.bottom - g.top + 18);
        const height = bottom - top;
        setSpot(
          height >= 60
            ? { x: Math.round(x), top: Math.round(top), height: Math.round(height) }
            : null,
        );
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll(".gm-plate, .gm-body, .gm-session").forEach((el) => ro.observe(el));
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selfRef]);
  return spot;
}

export function TreeVolume() {
  const self = useRef<HTMLDivElement>(null);
  const spot = useSpot(self);
  const [vol, setVol] = useState(1);
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVol(getMusicVolume()); // saved volume (browser only, so the server render matches)
    const off = onMusicVolume(setVol);
    return () => {
      off();
    };
  }, []);

  const fromPointer = useCallback((clientY: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    const usable = r.height - THUMB;
    setMusicVolume(1 - (clientY - r.top - THUMB / 2) / usable);
  }, []);

  const pct = Math.round(vol * 100);
  // Rendered from the start (hidden until measured) so it can find the machine it belongs to.
  return (
    <div
      ref={self}
      className={`gm-vol${dragging ? " is-dragging" : ""}`}
      style={
        spot
          ? { left: spot.x, top: spot.top - THUMB / 2, height: spot.height + THUMB }
          : { display: "none" }
      }
    >
      <div
        ref={track}
        className="gm-vol-track"
        role="slider"
        tabIndex={0}
        aria-label="Music volume"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={pct === 0 ? "Music off" : `${pct}%`}
        title={`Music volume: ${pct === 0 ? "off" : `${pct}%`} (drag up for louder)`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          setDragging(true);
          fromPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientY);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onKeyDown={(e) => {
          const stepBy: Record<string, number> = {
            ArrowUp: 0.05,
            ArrowRight: 0.05,
            ArrowDown: -0.05,
            ArrowLeft: -0.05,
            PageUp: 0.2,
            PageDown: -0.2,
          };
          if (e.key === "Home") setMusicVolume(0);
          else if (e.key === "End") setMusicVolume(1);
          else if (e.key in stepBy) setMusicVolume(getMusicVolume() + stepBy[e.key]!);
          else return;
          e.preventDefault();
        }}
      >
        <span
          className="gm-vol-fill"
          aria-hidden
          style={{ height: `calc((100% - ${THUMB}px) * ${vol} + ${THUMB / 2}px)` }}
        />
        <span
          className="gm-vol-thumb"
          aria-hidden
          style={{ bottom: `calc((100% - ${THUMB}px) * ${vol})` }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
            {vol > 0 && <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />}
            {vol > 0.5 && <path d="M18 7a7 7 0 0 1 0 10" />}
            {vol === 0 && <path d="M16 10l4 4M20 10l-4 4" />}
          </svg>
        </span>
      </div>
      <span className="gm-vol-label" aria-hidden>
        {pct === 0 ? "Off" : "Vol"}
      </span>
    </div>
  );
}
