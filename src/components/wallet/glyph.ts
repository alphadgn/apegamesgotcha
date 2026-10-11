// Login with Glyph, straight through Privy's cross-app login. Glyph (Yuga Labs' ApeChain wallet) is a Privy
// "provider app": players sign in through Glyph's own window and the app gets their Glyph wallet as a
// `cross_app` linked account, which signs transactions through Glyph's window too.
//
// This deliberately doesn't use the Glyph SDK's provider: that provider renders nothing at all (not even
// the app's windows inside it) until it has downloaded a chain list from useglyph.io, and never retries if
// that request fails, which left sign-in stuck on "Loading Glyph…".
import { useCallback, useMemo } from "react";
import { useCrossAppAccounts, usePrivy, type User } from "@privy-io/react-auth";
import type { Hex } from "viem";

/** Glyph's Privy app ID (the "Glyph" entry under Privy → Global wallet → Integrations). */
export const GLYPH_PRIVY_APP_ID = "cly38x0w10ac945q9yg9sm71i";
/** Privy login method that shows "Login with Glyph". */
export const GLYPH_LOGIN_METHOD = `privy:${GLYPH_PRIVY_APP_ID}` as const;

/** The Glyph wallet address on a Privy user, if they signed in with (or linked) Glyph. */
export function glyphAddress(user: User | null | undefined): string | null {
  for (const a of user?.linkedAccounts ?? []) {
    if (a.type !== "cross_app") continue;
    const acct = a as unknown as {
      providerApp?: { id?: string };
      embeddedWallets?: { address: string }[];
      smartWallets?: { address: string }[];
    };
    if (acct.providerApp?.id !== GLYPH_PRIVY_APP_ID) continue;
    return acct.embeddedWallets?.[0]?.address ?? acct.smartWallets?.[0]?.address ?? null;
  }
  return null;
}

/** Everything the app needs from Glyph: who's signed in, opening Glyph's window, and sending a transaction. */
export function useGlyphAccount() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const cross = useCrossAppAccounts();
  const address = useMemo(() => (authenticated ? glyphAddress(user) : null), [authenticated, user]);

  /** Opens Glyph's sign-in window. Call it straight from a tap, or the browser may block the window. */
  const login = useCallback(
    () => cross.loginWithCrossAppAccount({ appId: GLYPH_PRIVY_APP_ID }),
    [cross],
  );

  const sendTransaction = useCallback(
    async (tx: { to: string; value?: bigint; data?: Hex | undefined; chainId: number }) => {
      if (!address) throw new Error("Sign in with Glyph first");
      const hash = await cross.sendTransaction(
        {
          to: tx.to,
          chainId: tx.chainId,
          ...(tx.value !== undefined ? { value: tx.value } : {}),
          ...(tx.data ? { data: tx.data } : {}),
        },
        { address },
      );
      return hash as Hex;
    },
    [cross, address],
  );

  return { ready, authenticated, address, login, logout, getAccessToken, sendTransaction };
}
