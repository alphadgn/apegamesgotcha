// Burn window through Privy (rendered inside the app-wide PrivyProvider; loaded on demand).
import { usePrivyWalletAdapter } from "./PrivyCheckout";
import { BurnPanel, type NftSettings } from "./BurnPanel";
import type { BurnTarget } from "./walletUi";

export default function PrivyBurn({
  nft,
  target,
  onBurned,
}: {
  nft: NftSettings;
  target: BurnTarget;
  onBurned: () => void;
}) {
  const wallet = usePrivyWalletAdapter(target.owner);
  return <BurnPanel nft={nft} target={target} wallet={wallet} onBurned={onBurned} />;
}
