// App-wide wallet UI state: the sign-in window, the Refill (payment) window and "add a wallet".
// Any component can open them; WalletHost (mounted once in the root shell) renders them.
import { useSyncExternalStore } from "react";

export type WalletUiState = {
  /** Something asked for a wallet window at least once, so the wallet code has been loaded. */
  activated: boolean;
  signIn: boolean;
  /** What to open once sign-in finishes. */
  afterSignIn: "refill" | null;
  refill: boolean;
  /** Bumped each time a player asks to add a wallet from their account page. */
  linkRequest: number;
  /** NFT the player is burning for a free spin (the burn window is open while set). */
  burn: BurnTarget | null;
};

export type BurnTarget = { tokenId: string; owner: string; level: number | null };

let state: WalletUiState = {
  activated: false,
  signIn: false,
  afterSignIn: null,
  refill: false,
  linkRequest: 0,
  burn: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<WalletUiState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const getWalletUi = () => state;

export function useWalletUi() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Loads the wallet layer without opening anything (e.g. a page returning from Glyph's sign-in tab). */
export function activateWallet() {
  if (!state.activated) set({ activated: true });
}

/** Opens the sign-in window (Privy). `then: "refill"` opens the payment window right after. */
export function openSignIn(opts: { then?: "refill" } = {}) {
  set({ activated: true, signIn: true, afterSignIn: opts.then ?? null, refill: false });
}
export function closeSignIn() {
  set({ signIn: false, afterSignIn: null });
}

/** Opens the Refill window (buy spins with APE). Callers decide whether the player is signed in first. */
export function openRefill() {
  set({ activated: true, refill: true, signIn: false });
}
export function closeRefill() {
  set({ refill: false });
}

/** Account page: add another wallet to this account. `then: "refill"` reopens the payment window after. */
export function requestLinkWallet(opts: { then?: "refill" } = {}) {
  set({
    activated: true,
    linkRequest: state.linkRequest + 1,
    afterSignIn: opts.then ?? null,
    refill: false,
    burn: null,
  });
}

/** Opens the burn window for one NFT (sends it to the burn address from the wallet that holds it). */
export function openBurn(target: BurnTarget) {
  set({ activated: true, burn: target, refill: false, signIn: false });
}
export function closeBurn() {
  set({ burn: null });
}

// ---- Sign-out: the Glyph layer registers its Privy logout so sign-out can end the Glyph session too ----
let privyLogout: (() => Promise<void>) | null = null;
const logoutWaiters = new Set<() => void>();

/** Called by the Glyph layer when it's up (and with null when it goes away). */
export function registerPrivyLogout(fn: (() => Promise<void>) | null) {
  privyLogout = fn;
  if (fn) logoutWaiters.forEach((w) => w());
}

/** The Privy logout, loading the Glyph layer first if needed (gives up after `ms`). */
export function getPrivyLogout(ms = 4000): Promise<(() => Promise<void>) | null> {
  if (privyLogout) return Promise.resolve(privyLogout);
  activateWallet();
  return new Promise((resolve) => {
    const done = () => {
      logoutWaiters.delete(done);
      clearTimeout(t);
      resolve(privyLogout);
    };
    const t = setTimeout(done, ms);
    logoutWaiters.add(done);
  });
}

// ---- Glyph payments from any page (e.g. a vendor paying a gift certificate): the Glyph layer registers a sender ----
export type GlyphSender = {
  /** The connected Glyph wallet (lowercase), or null when Glyph isn't connected in this browser. */
  address: string | null;
  send: (tx: { to: string; value: bigint; chainId: number }) => Promise<`0x${string}`>;
};
let glyphSender: GlyphSender | null = null;
const senderWaiters = new Set<() => void>();

/** Called by the Glyph layer whenever its wallet changes (null when it goes away). */
export function registerGlyphSender(s: GlyphSender | null) {
  glyphSender = s;
  if (s) senderWaiters.forEach((w) => w());
}

/** The Glyph sender, loading the Glyph layer first if needed (gives up after `ms`). */
export function getGlyphSender(ms = 8000): Promise<GlyphSender | null> {
  if (glyphSender?.address) return Promise.resolve(glyphSender);
  activateWallet();
  return new Promise((resolve) => {
    const done = () => {
      if (glyphSender && !glyphSender.address) return; // layer up, wallet still connecting: keep waiting
      senderWaiters.delete(done);
      clearTimeout(t);
      resolve(glyphSender);
    };
    const t = setTimeout(() => {
      senderWaiters.delete(done);
      resolve(glyphSender);
    }, ms);
    senderWaiters.add(done);
  });
}
