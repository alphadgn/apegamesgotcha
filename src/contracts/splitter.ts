// GotchaFeeSplitter (Gotcha Treasury): the contract that splits Gotcha fees (native APE on ApeChain) into 8
// buckets. The source is compiled in the browser with exactly these settings (Admin → Treasury → Deploy); the
// ABI is kept here, and the creation bytecode's SHA-256 lets both the page and the server check that what gets
// deployed is this exact source.
import abiJson from "./GotchaFeeSplitter.abi.json";
import type { Abi } from "viem";

export const SPLITTER_ABI = abiJson as Abi;
export const SPLITTER_FILE = "GotchaFeeSplitter.sol";
export const SPLITTER_NAME = "GotchaFeeSplitter";

export const COMPILER = {
  version: "0.8.24+commit.e11b9ed9",
  /** ApeScan's dropdown label. */
  label: "v0.8.24+commit.e11b9ed9",
  optimizer: true,
  runs: 200,
  evmVersion: "shanghai",
  license: "MIT",
} as const;

/** SHA-256 of the creation bytecode (hex text, no 0x) that solc 0.8.24 produces for the source in this folder. */
export const EXPECTED_BYTECODE_SHA256 =
  "5ace9db773881b487f1fa1dabb6753a718e748664fe628fd756d26b4856a3c21";

/** The compiler's standard JSON input (also what ApeScan's "Standard-Json-Input" verification takes). */
export function standardJsonInput(source: string) {
  return {
    language: "Solidity",
    sources: { [SPLITTER_FILE]: { content: source } },
    settings: {
      optimizer: { enabled: COMPILER.optimizer, runs: COMPILER.runs },
      evmVersion: COMPILER.evmVersion,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
}

/** Default owner (the address Gotcha fees go to today). */
export const DEFAULT_OWNER = "0x8c8df8cf3ed6e9ed3ac74a6b925e042289a5f332";

export const BUCKETS = [
  { name: "Team", bps: 4000, mode: "Direct" },
  { name: "Operations", bps: 1000, mode: "Direct" },
  { name: "Stock tokens", bps: 500, mode: "Accrue" },
  { name: "Stock certificates", bps: 500, mode: "Accrue" },
  { name: "StonkBroker NFT for gotcha", bps: 1000, mode: "Accrue" },
  { name: "Buy & burn $STONKBROKER", bps: 1000, mode: "Accrue" },
  { name: "BAYC for gotcha", bps: 1000, mode: "Accrue" },
  { name: "MAYC for gotcha", bps: 1000, mode: "Accrue" },
] as const;

export type SplitterChainId = 33139 | 33111;
export const SPLITTER_CHAINS: Record<
  SplitterChainId,
  { id: SplitterChainId; name: string; rpc: string; explorer: string; testnet: boolean }
> = {
  33111: {
    id: 33111,
    name: "ApeChain Curtis (testnet)",
    rpc: "https://rpc.curtis.apechain.com",
    explorer: "https://curtis.apescan.io",
    testnet: true,
  },
  33139: {
    id: 33139,
    name: "ApeChain",
    rpc: "https://rpc.apechain.com/http",
    explorer: "https://apescan.io",
    testnet: false,
  },
};
export const isSplitterChain = (id: number): id is SplitterChainId => id === 33139 || id === 33111;
