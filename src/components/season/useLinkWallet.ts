import { useServerFn } from "@tanstack/react-start";
import { createWalletChallenge, verifyWalletChallenge } from "@/lib/identity.functions";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/**
 * Prove control of a browser wallet with Sign-In with Ethereum: the server issues a domain/URI/chain
 * bound, expiring, single-use message; the wallet signs it (EOA or contract wallet); the server verifies.
 */
export function useLinkWalletWithSignature() {
  const challengeFn = useServerFn(createWalletChallenge);
  const verifyFn = useServerFn(verifyWalletChallenge);
  return async () => {
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!eth) throw new Error("No browser wallet found. Use “Add via Privy” for mobile wallets.");
    const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!address) throw new Error("No account selected");
    const chainId = parseInt((await eth.request({ method: "eth_chainId" })) as string, 16);
    const { nonce, message } = await challengeFn({ data: { address, chainId } });
    const signature = (await eth.request({
      method: "personal_sign",
      params: [message, address],
    })) as string;
    return verifyFn({ data: { nonce, signature } });
  };
}
