// Gotcha Treasury settings (app_config.treasury): shared by the admin page, the server functions and the keeper.
// Safe to import in the browser (no secrets here — keys live in Lovable → Secrets).

export type BucketSettings = { enabled: boolean; max_spend_eth: string };

export type TreasurySettings = {
  /** Which network's active splitter the dashboard and keeper use. */
  splitter_chain_id: 33139 | 33111;
  /** ON by default: the keeper logs what it would do and sends nothing. */
  dry_run: boolean;
  /** Stops the keeper and every manual treasury transaction. */
  kill_switch: boolean;
  /** Extra APE added to each floor target (bridge + price moves), percent. */
  buffer_pct: number;
  /** Abort a buy when the bridge gives this much less ETH than the target was set for, percent. */
  slippage_pct: number;
  /** Only send a new target on-chain when it moved more than this, percent. */
  target_move_pct: number;
  /** APE kept in the keeper wallet for ApeChain gas (not bridged). */
  ape_gas_reserve: string;
  /** ETH kept aside on the destination chain for the buy + transfer gas. */
  gas_allowance_eth: { ethereum: string; robinhood: string };
  /** Per bucket (2–7): on/off and the most ETH one buy may cost. */
  buckets: Record<string, BucketSettings>;
  /** Where bought NFTs go. */
  prize_wallet_ethereum: string;
  prize_wallet_robinhood: string;
  /** Robinhood Chain (StonkBroker NFT + $STONKBROKER). */
  robinhood_chain_id: number;
  robinhood_rpc_url: string;
  /** OpenSea's name for Robinhood Chain and the StonkBroker collection. */
  robinhood_opensea_chain: string;
  stonk_marketplace: "opensea";
  stonk_nft_contract: string;
  stonk_nft_slug: string;
  stonk_token: string;
  /** OpenSea collection slugs for the Ethereum buys. */
  bayc_slug: string;
  mayc_slug: string;
  eth_rpc_url: string;
  /** Telegram chat that gets failure alerts (bot token = TELEGRAM_BOT_TOKEN secret). */
  telegram_chat_id: string;
  /** Send Gotcha spin payments to the active ApeChain mainnet splitter (deposit()) instead of the treasury wallet. */
  fees_to_splitter: boolean;
};

export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

export const DEFAULT_TREASURY_SETTINGS: TreasurySettings = {
  splitter_chain_id: 33111,
  dry_run: true,
  kill_switch: false,
  buffer_pct: 5,
  slippage_pct: 3,
  target_move_pct: 2,
  ape_gas_reserve: "1",
  gas_allowance_eth: { ethereum: "0.01", robinhood: "0.0005" },
  buckets: {
    "2": { enabled: false, max_spend_eth: "0" },
    "3": { enabled: false, max_spend_eth: "0" },
    "4": { enabled: false, max_spend_eth: "1" },
    "5": { enabled: false, max_spend_eth: "1" },
    "6": { enabled: false, max_spend_eth: "15" },
    "7": { enabled: false, max_spend_eth: "5" },
  },
  prize_wallet_ethereum: "",
  prize_wallet_robinhood: "",
  robinhood_chain_id: 4663,
  robinhood_rpc_url: "",
  robinhood_opensea_chain: "robinhood",
  stonk_marketplace: "opensea",
  stonk_nft_contract: "",
  stonk_nft_slug: "",
  stonk_token: "",
  bayc_slug: "boredapeyachtclub",
  mayc_slug: "mutant-ape-yacht-club",
  eth_rpc_url: "",
  telegram_chat_id: "",
  fees_to_splitter: false,
};

export function withDefaults(v: Partial<TreasurySettings> | null | undefined): TreasurySettings {
  const d = DEFAULT_TREASURY_SETTINGS;
  const s = { ...d, ...(v ?? {}) } as TreasurySettings;
  s.gas_allowance_eth = { ...d.gas_allowance_eth, ...(v?.gas_allowance_eth ?? {}) };
  s.buckets = Object.fromEntries(
    Object.entries(d.buckets).map(([k, b]) => [k, { ...b, ...(v?.buckets?.[k] ?? {}) }]),
  );
  return s;
}

/** What each bucket buys (2–7). */
export const BUCKET_JOBS: Record<
  number,
  { kind: "stock" | "nft" | "burn"; chain: "ethereum" | "robinhood" | null; label: string }
> = {
  2: { kind: "stock", chain: null, label: "Stock tokens (released to its recipient)" },
  3: { kind: "stock", chain: null, label: "Stock certificates (released to its recipient)" },
  4: { kind: "nft", chain: "robinhood", label: "Buy 1 floor StonkBroker NFT → prize wallet" },
  5: { kind: "burn", chain: "robinhood", label: "Buy $STONKBROKER → burn (0x…dEaD)" },
  6: { kind: "nft", chain: "ethereum", label: "Buy 1 floor BAYC → prize wallet" },
  7: { kind: "nft", chain: "ethereum", label: "Buy 1 floor MAYC → prize wallet" },
};

export type JobStatus =
  | "releasing"
  | "released"
  | "bridging"
  | "bridged"
  | "buying"
  | "bought"
  | "delivering"
  | "delivered"
  | "failed";
