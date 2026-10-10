// The app's sign-in window, in ApeGames colours (dark panel, gold accent). One look for every state: while
// Glyph loads, when it can't, and ready — where its button opens Glyph's own sign-in window.
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
  onContinue,
  continueLabel = "Continue with Glyph",
  onSwitchAccount,
  onClose,
}: {
  open: boolean;
  mode?: "sign-in" | "link";
  /** Shown instead of the button while Glyph isn't ready (loading, not set up, can't load). */
  status?: string | undefined;
  onContinue?: (() => void) | undefined;
  continueLabel?: string;
  onSwitchAccount?: (() => void) | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-card" style={{ borderColor: `${SIGN_IN_GOLD}66` }}>
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle className="text-2xl">
            {mode === "link" ? "Add your Glyph wallet" : "Sign in to ApeGames Gotcha"}
          </DialogTitle>
          <DialogDescription>
            {mode === "link"
              ? "Link Glyph to this account so you can sign in with it and pay with your Glyph wallet."
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
          <p className="text-center text-xs text-muted-foreground">
            New to Glyph? Create one in the Glyph window with email, a social account or a wallet.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
