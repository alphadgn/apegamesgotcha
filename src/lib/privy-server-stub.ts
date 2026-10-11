// Server-only stand-in for @privy-io/react-auth. Privy (and the WalletConnect / pino code it bundles) only runs
// in the browser: the sign-in layer is loaded on demand there. On the server, bundling the real package made
// nitro put viem's core functions inside Privy's chunk, so every server call that used viem (Chainlink VRF
// draws, NFT reads) also loaded Privy's Node-only logger, which crashes the deployed worker with
// `The "superCtor.prototype" property must be of type object`. These inert exports are never rendered.
import type { ReactNode } from "react";

export type User = { id: string; linkedAccounts: unknown[] };
export type PrivyClientConfig = Record<string, unknown>;

const notOnServer = () => Promise.reject(new Error("Wallet sign-in only runs in the browser"));

export function PrivyProvider({ children }: { children?: ReactNode }) {
  return children ?? null;
}
export const usePrivy = () => ({
  ready: false,
  authenticated: false,
  user: null as User | null,
  getAccessToken: async () => null as string | null,
  logout: async () => {},
});
export const useCrossAppAccounts = () => ({
  loginWithCrossAppAccount: notOnServer,
  linkCrossAppAccount: notOnServer,
  signMessage: notOnServer,
  sendTransaction: notOnServer,
});
export const useConnectWallet = (_options?: unknown) => ({ connectWallet: () => {} });
export const useModalStatus = () => ({ isOpen: false });
