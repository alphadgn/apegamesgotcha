// Burn one Level 4+ NFT for a free spin: the player's wallet sends it to the burn address on ApeChain,
// then the server verifies the transfer on-chain and adds the spin. Works with Privy or a browser wallet.
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { claimBurn } from "@/lib/app.functions";
import { Button } from "@/components/ui/button";
import type { WalletAdapter } from "./CheckoutPanel";
import type { BurnTarget } from "./walletUi";

export type NftSettings = {
  contract: string;
  chain_id: number;
  rpc_url: string;
  explorer_url: string;
  burn_address: string;
  burn_min_level: number;
};

const ERC721 = parseAbi(["function transferFrom(address from, address to, uint256 tokenId)"]);
const PENDING_KEY = "gm-pending-burn";
type PendingBurn = { tokenId: string; txHash: Hex };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function readPendingBurn(): PendingBurn | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingBurn) : null;
  } catch {
    return null;
  }
}
function savePendingBurn(p: PendingBurn | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Ask the server to verify a burn until ApeChain has it, then the spin is credited. */
export function useBurnConfirmer() {
  const claimFn = useServerFn(claimBurn);
  return useCallback(
    async (p: PendingBurn, isCancelled: () => boolean = () => false) => {
      const deadline = Date.now() + 5 * 60_000;
      while (!isCancelled() && Date.now() < deadline) {
        const r = await claimFn({ data: { tokenId: p.tokenId, txHash: p.txHash } });
        if (r.status === "credited") {
          savePendingBurn(null);
          return true;
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
      return false;
    },
    [claimFn],
  );
}

type Step =
  | { kind: "ready" }
  | { kind: "wallet" }
  | { kind: "confirming"; hash: Hex }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function BurnPanel({
  nft,
  target,
  wallet,
  onBurned,
}: {
  nft: NftSettings;
  target: BurnTarget;
  wallet: WalletAdapter;
  onBurned: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "ready" });
  const [agreed, setAgreed] = useState(false);
  const confirm = useBurnConfirmer();
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false; // reset on (re)mount — React dev mode mounts twice
    return () => {
      cancelled.current = true;
    };
  }, []);

  const finish = useCallback(
    async (pending: PendingBurn) => {
      setStep({ kind: "confirming", hash: pending.txHash });
      try {
        const ok = await confirm(pending, () => cancelled.current);
        if (cancelled.current) return;
        if (ok) {
          setStep({ kind: "done" });
          onBurned();
        } else
          setStep({
            kind: "error",
            message:
              "Still waiting for ApeChain to confirm the burn. Your free spin is added once it confirms — reopen this window to check.",
          });
      } catch (e) {
        setStep({ kind: "error", message: (e as Error).message });
      }
    },
    [confirm, onBurned],
  );

  // A burn that was still confirming when the window or page closed is finished here.
  useEffect(() => {
    const p = readPendingBurn();
    if (p && p.tokenId === target.tokenId) void finish(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eligible = target.level != null && target.level >= nft.burn_min_level;
  const rightWallet =
    !!wallet.address && wallet.address.toLowerCase() === target.owner.toLowerCase();
  const configured =
    /^0x[0-9a-fA-F]{40}$/.test(nft.contract) && /^0x[0-9a-fA-F]{40}$/.test(nft.burn_address);
  const txLink = (h: string) => `${nft.explorer_url.replace(/\/$/, "")}/tx/${h}`;

  const burn = async () => {
    if (!wallet.address) return;
    setStep({ kind: "wallet" });
    try {
      const data = encodeFunctionData({
        abi: ERC721,
        functionName: "transferFrom",
        args: [target.owner as Hex, nft.burn_address as Hex, BigInt(target.tokenId)],
      });
      const hash = await wallet.pay({
        to: nft.contract,
        valueWei: "0",
        data,
        chainId: nft.chain_id,
      });
      const pending = { tokenId: target.tokenId, txHash: hash };
      savePendingBurn(pending); // so the spin is still credited if this window closes
      await finish(pending);
    } catch (e) {
      const msg =
        (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? "Burn failed";
      setStep({
        kind: "error",
        message: /reject|denied|cancel/i.test(msg) ? "Burn cancelled in your wallet." : msg,
      });
    }
  };

  if (step.kind === "done") {
    return (
      <div className="gm-rf-done">
        <div className="gm-rf-big">+1</div>
        <p>free spin added to your machine</p>
      </div>
    );
  }

  return (
    <div className="gm-rf">
      <p className="gm-rf-copy">
        Burning sends NFT <b>#{target.tokenId}</b> (Level {target.level ?? "?"}) to the burn address{" "}
        <span className="break-all font-mono">{short(nft.burn_address)}</span> on ApeChain. It can't
        be undone. You get <b>1 free spin</b> once the burn confirms.
      </p>
      {!eligible && (
        <p className="gm-rf-error">
          Only Level {nft.burn_min_level}+ NFTs can be burned for a spin
          {target.level == null
            ? " — this NFT's level couldn't be read yet. Ask an admin to verify it first."
            : "."}
        </p>
      )}
      {!configured && (
        <p className="gm-rf-error">
          Burning isn't set up yet (NFT contract or burn address missing).
        </p>
      )}

      <div className="gm-rf-wallet">
        {wallet.address ? (
          <span>
            {wallet.label} <b>{short(wallet.address)}</b>
          </span>
        ) : (
          <span>No wallet connected</span>
        )}
        {wallet.disconnect && wallet.address && step.kind === "ready" && (
          <button type="button" className="gm-rf-link" onClick={() => void wallet.disconnect?.()}>
            Switch
          </button>
        )}
      </div>
      {wallet.address && !rightWallet && (
        <p className="gm-rf-warn">
          This NFT is in <b>{short(target.owner)}</b>. Connect that wallet to burn it.
        </p>
      )}

      {step.kind === "error" && <p className="gm-rf-error">{step.message}</p>}
      {step.kind === "confirming" && (
        <p className="gm-rf-status">
          Confirming the burn on ApeChain…{" "}
          <a href={txLink(step.hash)} target="_blank" rel="noreferrer">
            View transaction ↗
          </a>
        </p>
      )}

      {eligible && configured && rightWallet && step.kind !== "confirming" && (
        <label className="flex items-start gap-2 text-left text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>I understand NFT #{target.tokenId} is destroyed for good.</span>
        </label>
      )}

      {!wallet.address || !rightWallet ? (
        <Button
          type="button"
          className="gm-rf-cta"
          disabled={!wallet.ready}
          onClick={() => void wallet.connect()}
        >
          {wallet.ready
            ? wallet.address
              ? "Connect the wallet holding this NFT"
              : "Connect wallet"
            : "Loading wallet…"}
        </Button>
      ) : (
        <Button
          type="button"
          className="gm-rf-cta"
          disabled={
            !eligible ||
            !configured ||
            !agreed ||
            step.kind === "wallet" ||
            step.kind === "confirming"
          }
          onClick={() => void burn()}
        >
          {step.kind === "wallet"
            ? "Approve in your wallet…"
            : step.kind === "confirming"
              ? "Confirming…"
              : `Burn #${target.tokenId} for 1 free spin`}
        </Button>
      )}
    </div>
  );
}
