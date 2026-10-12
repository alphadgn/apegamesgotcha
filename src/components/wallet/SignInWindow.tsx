// The app's sign-in window, in ApeGames colours (dark panel, gold accent). One look for every state: while
// Glyph loads, when it can't, and ready — where its button opens Glyph's own sign-in window.
import { useSyncExternalStore, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** The sign-in window's accent (the gold the sign-in window has always used). */
export const SIGN_IN_GOLD = "#f6c343";

export function SignInWindow({
  open,
  mode = "sign-in",
  status,
  detail,
  onContinue,
  continueLabel = "Continue with Glyph",
  onSwitchAccount,
  secondary,
  note,
  extra,
  onClose,
}: {
  open: boolean;
  mode?: "sign-in" | "link";
  /** Shown instead of the button while Glyph isn't ready (loading, not set up, can't load). */
  status?: string | undefined;
  /** Small print under the button (e.g. why Glyph can't start). */
  detail?: string | undefined;
  onContinue?: (() => void) | undefined;
  continueLabel?: string;
  onSwitchAccount?: (() => void) | undefined;
  /** A second choice under the main button (e.g. "Connect another wallet"). */
  secondary?: { label: string; onClick?: (() => void) | undefined } | undefined;
  /** Small neutral line under the buttons (e.g. "2 of 5 wallets linked"). */
  note?: string | undefined;
  /** More choices under the buttons (e.g. "Add it from your wallet app"). */
  extra?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-card" style={{ borderColor: `${SIGN_IN_GOLD}66` }}>
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle className="text-2xl">
            {mode === "link" ? "Add a wallet" : "Sign in to ApeGames Gotcha"}
          </DialogTitle>
          <DialogDescription>
            {mode === "link"
              ? "Add a wallet you own: your Glyph wallet, or MetaMask, Coinbase Wallet or Trust Wallet. Each wallet signs a free message to prove it's yours. No transaction, no fees."
              : "Sign in with Glyph, the ApeChain wallet, to buy spins, win real prizes and climb the leaderboard."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-1 pb-1">
          <button
            type="button"
            onClick={onContinue}
            disabled={!onContinue}
            className="min-h-12 w-full rounded-lg px-3 py-2 text-base font-bold transition hover:brightness-110 disabled:cursor-default disabled:opacity-70"
            style={{ backgroundColor: SIGN_IN_GOLD, color: "#141414" }}
          >
            {onContinue ? continueLabel : (status ?? "Loading Glyph…")}
          </button>
          {secondary && (
            <button
              type="button"
              onClick={secondary.onClick}
              disabled={!secondary.onClick}
              className="min-h-12 w-full rounded-lg border px-3 py-2 text-base font-bold transition hover:bg-white/5 disabled:cursor-default disabled:opacity-60"
              style={{ borderColor: SIGN_IN_GOLD, color: SIGN_IN_GOLD }}
            >
              {secondary.label}
            </button>
          )}
          {extra}
          {note && <p className="text-center text-xs text-muted-foreground">{note}</p>}
          {detail && <p className="break-words text-center text-xs text-destructive">{detail}</p>}
          {onSwitchAccount && (
            <button
              type="button"
              onClick={onSwitchAccount}
              className="text-sm underline"
              style={{ color: SIGN_IN_GOLD }}
            >
              Use a different Glyph account
            </button>
          )}
          {mode === "sign-in" && (
            <p className="text-center text-xs text-muted-foreground">
              New to Glyph? Create one in the Glyph window with email, a social account or a wallet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- One sign-in window for the whole app ----
// WalletHost renders a single <HostedSignInWindow> from the first tap. The Glyph layer (loaded later) feeds
// it through this store instead of rendering a window of its own, so the window doesn't flash while
// settings and Glyph load (each swap to a new window used to re-run the open animation).
type SignInWindowProps = Parameters<typeof SignInWindow>[0];
/** What the Glyph layer wants shown; `hidden` = step aside (unmounted) while Glyph's own window works. */
export type SignInControls = (SignInWindowProps & { hidden?: boolean }) | null;

let controls: SignInControls = null;
const listeners = new Set<() => void>();

export function setSignInControls(next: SignInControls) {
  controls = next;
  listeners.forEach((l) => l());
}

function useSignInControls() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => controls,
    () => null,
  );
}

/** The app's one sign-in window: the Glyph layer's state once it's up, `fallback` until then. */
export function HostedSignInWindow({ fallback }: { fallback: SignInWindowProps }) {
  const c = useSignInControls();
  if (c?.hidden) return null; // unmounted, so its focus trap can't compete with Privy's step
  return <SignInWindow {...(c ?? fallback)} />;
}
