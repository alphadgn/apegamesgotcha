import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { GuidePanel } from "./GuidePanel";

/** Opens the Captain Ape guide in a slide-up panel so players never leave the machine. */
export function GuideButton({ className, label = "Ask the guide" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ?? "gm-refill-btn"} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[85vh] max-w-3xl mx-auto flex flex-col gap-2 p-4">
          <SheetHeader className="p-0">
            <SheetTitle>Captain Ape — your guide</SheetTitle>
            <SheetDescription>Points, spins, prizes and Charleston — ask away.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{open && <GuidePanel compact />}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
