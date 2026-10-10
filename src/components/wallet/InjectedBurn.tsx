// Burn window with a browser-extension wallet (used when Privy isn't configured or failed to load).
import { useInjectedWalletAdapter } from "./InjectedCheckout";
import { BurnPanel, type NftSettings } from "./BurnPanel";
import type { BurnTarget } from "./walletUi";

export default function InjectedBurn({
  nft,
  target,
  onBurned,
}: {
  nft: NftSettings;
  target: BurnTarget;
  onBurned: () => void;
}) {
  const wallet = useInjectedWalletAdapter(nft);
  if (!wallet)
    return (
      <p className="gm-rf-warn">
        No browser wallet found. Install MetaMask (or another wallet) to burn from it.
      </p>
    );
  return <BurnPanel nft={nft} target={target} wallet={wallet} onBurned={onBurned} />;
}
