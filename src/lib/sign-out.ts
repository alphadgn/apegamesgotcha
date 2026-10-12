// Signing out ends everything, so the next sign-in starts over from the beginning:
// 1. the Glyph / Privy session (revoked with Privy, and its saved tokens removed from this browser),
// 2. the app session (Supabase), on every device,
// 3. anything saved about the player in this browser, then a fresh page load (no data left in memory).
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getPrivyLogout } from "@/components/wallet/walletUi";

/** Keys this app keeps per player in the browser (pending payments/burns etc.). */
const APP_KEYS = ["gm-pending-purchase", "gm-pending-burn"];

function clearPrivyStorage() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k && (k.startsWith("privy") || APP_KEYS.includes(k))) store.removeItem(k);
      }
    } catch {
      /* storage unavailable */
    }
  }
  // Privy can also keep its session in cookies (privy-token, privy-refresh-token, privy-session, privy-id-token).
  const host = location.hostname;
  const domains = ["", host, `.${host}`, `.${host.split(".").slice(-2).join(".")}`];
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (!name?.startsWith("privy")) continue;
    for (const d of domains)
      document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ""}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }
}

let inProgress = false;

/** Shown once on the next page after an automatic sign-out. */
export const SIGN_OUT_NOTICE_KEY = "gm-signed-out-notice";

/**
 * `scope: "local"` ends the session only in this browser (used by the inactivity timer, so a quiet laptop doesn't
 * sign the player out on their phone). `notice` is shown after the page reloads.
 */
export async function signOutEverywhere(opts: { scope?: "global" | "local"; notice?: string } = {}) {
  if (inProgress) return;
  inProgress = true;
  toast.loading("Signing out…");
  if (opts.notice) {
    try {
      sessionStorage.setItem(SIGN_OUT_NOTICE_KEY, opts.notice);
    } catch {
      /* storage unavailable */
    }
  }
  // Glyph / Privy first (revokes the session with Privy), but never let it block signing out.
  try {
    const logout = await getPrivyLogout();
    if (logout) await Promise.race([logout(), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    /* continue */
  }
  clearPrivyStorage();
  // App session: revoke it everywhere; if the network fails, at least end it in this browser.
  const { error } = await supabase.auth.signOut({ scope: opts.scope ?? "global" });
  if (error) await supabase.auth.signOut({ scope: "local" });
  clearPrivyStorage();
  window.location.replace("/");
}
