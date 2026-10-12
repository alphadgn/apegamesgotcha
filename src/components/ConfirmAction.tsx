// "Are you sure?" window for admin actions. Call `await confirmAction({ … })` from any click handler; it resolves
// true only when the admin presses the confirm button. `<ConfirmHost />` is rendered once (admin console).
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  /** What will happen, in plain words. */
  description?: ReactNode;
  /** Label of the confirm button (default "Confirm"). */
  confirmLabel?: string;
  /** Red confirm button for deleting / irreversible actions. */
  destructive?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
let show: ((p: Pending) => void) | null = null;

/** Asks the admin to confirm. Resolves true on confirm, false on cancel / close. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (!show) {
    const text = typeof opts.description === "string" ? `${opts.title}\n\n${opts.description}` : opts.title;
    return Promise.resolve(typeof window !== "undefined" && window.confirm(text));
  }
  const open = show;
  return new Promise((resolve) => open({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    show = (p) =>
      setPending((cur) => {
        cur?.resolve(false); // only one question at a time
        return p;
      });
    return () => {
      show = null;
    };
  }, []);
  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && finish(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          {pending?.description ? (
            <AlertDialogDescription className="break-words">{pending.description}</AlertDialogDescription>
          ) : (
            <AlertDialogDescription className="sr-only">Confirm this action</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={pending?.destructive ? buttonVariants({ variant: "destructive" }) : undefined}
            onClick={() => finish(true)}
          >
            {pending?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
