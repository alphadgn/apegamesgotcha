import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/useAuth";
import cover from "@/assets/guide-cover.webp";
import { GuidePanel } from "./GuidePanel";

function GuideSheet({ open, onOpenChange, publicMode = false }: { open: boolean; onOpenChange: (open: boolean) => void; publicMode?: boolean }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] max-w-3xl mx-auto flex flex-col gap-2 p-4">
        <SheetHeader className="p-0">
          <SheetTitle>Captain Ape — your guide</SheetTitle>
          <SheetDescription>Points, spins, prizes and Charleston — ask away.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">{open && <GuidePanel compact publicMode={publicMode} />}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Opens the Captain Ape guide in a slide-up panel so players never leave the machine. */
export function GuideButton({ className, label = "Ask the guide" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ?? "gm-refill-btn"} onClick={() => setOpen(true)}>
        {label}
      </button>
      <GuideSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Round floating guide widget, bottom-right on every page. Signed-out visitors
 * get a public guide (general info only) instead of being sent to sign in. */
export function FloatingGuide() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (path.startsWith("/guide")) return null; // the full guide page is already open

  const face = (
    <>
      <svg className="gw-arc" viewBox="0 0 100 100" aria-hidden="true">
        <path id="gw-arc-path" d="M 9 50 A 41 41 0 0 1 91 50" fill="none" />
        <text>
          <textPath href="#gw-arc-path" startOffset="50%" textAnchor="middle">
            GUIDE
          </textPath>
        </text>
      </svg>
      <span className="gw-btn">
        <img src={cover} alt="" width={64} height={64} draggable={false} />
      </span>
    </>
  );

  return (
    <div className="gw">
      <button
        type="button"
        className="gw-hit"
        aria-label={user ? "Open the guide" : "Ask the guide — no sign-in needed"}
        onClick={() => setOpen(true)}
      >
        {face}
      </button>
      <GuideSheet open={open} onOpenChange={setOpen} publicMode={!user} />
    </div>
  );
}
