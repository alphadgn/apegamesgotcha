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
};

let state: WalletUiState = {
  activated: false,
  signIn: false,
  afterSignIn: null,
  refill: false,
  linkRequest: 0,
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

/** Account page: add another wallet to this account. */
export function requestLinkWallet() {
  set({ activated: true, linkRequest: state.linkRequest + 1 });
}
