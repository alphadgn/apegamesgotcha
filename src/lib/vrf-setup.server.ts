// One-click setup of the on-chain prize draw (Chainlink VRF v2.5 on Base), run by an admin from the app.
//
// Uses the operator wallet (VRF_OPERATOR_PRIVATE_KEY, funded with a little Base ETH) to:
//   1. create a Chainlink VRF subscription (paid in ETH — no LINK needed)
//   2. fund it
//   3. deploy GotchaVRF (contracts/src/GotchaVRF.sol) wired to that subscription
//   4. add the contract as the subscription's consumer
//   5. save the addresses in app_config.vrf (the draw stays switched OFF until the admin turns it on)
// Every step is saved as it completes, so a failed or interrupted run picks up where it stopped.
// Server-only.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gotchaVrfAbi } from "./gotchaVrfAbi";
import { GOTCHA_VRF_BYTECODE } from "./gotchaVrfBytecode.server";

/** Chainlink's published VRF v2.5 values (docs.chain.link/vrf/v2-5/supported-networks; same as contracts/script). */
export const VRF_NETWORKS = {
  base: {
    chain: "base",
    chain_id: 8453,
    rpc_url: "https://mainnet.base.org",
    explorer_url: "https://basescan.org",
    coordinator: "0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634",
    key_hash: "0x00b81b5a830cb0a4009fbd8904de511e28631e62ce5ad231373d3cdad373ccab",
  },
  "base-sepolia": {
    chain: "base-sepolia",
    chain_id: 84532,
    rpc_url: "https://sepolia.base.org",
    explorer_url: "https://sepolia.basescan.org",
    coordinator: "0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE",
    key_hash: "0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71",
  },
} as const;
export type VrfNetworkName = keyof typeof VRF_NETWORKS;

export type VrfNetwork = {
  chain: string;
  chain_id: number;
  rpc_url: string;
  explorer_url: string;
  coordinator: string;
  key_hash: string;
};

/** What the setup stores in app_config.vrf (merged with what's already there). */
export type VrfSetupState = {
  chain?: string;
  chain_id?: number;
  rpc_url?: string;
  explorer_url?: string;
  coordinator?: string;
  key_hash?: string;
  sub_id?: string;
  sub_funded?: boolean;
  contract?: string;
  consumer_added?: boolean;
  native_payment?: boolean;
  enabled?: boolean;
};

const coordinatorAbi = parseAbi([
  "function createSubscription() returns (uint256 subId)",
  "function fundSubscriptionWithNative(uint256 subId) payable",
  "function addConsumer(uint256 subId, address consumer)",
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "event SubscriptionCreated(uint256 indexed subId, address owner)",
]);

const constructorAbi = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "coordinator", type: "address" },
      { name: "subId", type: "uint256" },
      { name: "keyHash_", type: "bytes32" },
      { name: "confirmations", type: "uint16" },
      { name: "gasBase", type: "uint32" },
      { name: "gasPerSpin", type: "uint32" },
      { name: "nativePayment_", type: "bool" },
      { name: "operator_", type: "address" },
    ],
  },
] as const;

function operatorKey(): Hex {
  const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error(
      "Add the operator wallet's private key as the server secret VRF_OPERATOR_PRIVATE_KEY first (0x + 64 hex characters).",
    );
  return key as Hex;
}

function clients(net: VrfNetwork, key: Hex) {
  const chain = defineChain({
    id: net.chain_id,
    name: net.chain,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [net.rpc_url] } },
  });
  const account = privateKeyToAccount(key);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(net.rpc_url) }),
    wallet: createWalletClient({ account, chain, transport: http(net.rpc_url) }),
  };
}

async function mined(pub: ReturnType<typeof clients>["pub"], hash: Hex, what: string) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${what} failed on-chain (tx ${hash})`);
  return receipt;
}

export type SetupStep = { step: string; detail: string; tx?: string };

/**
 * Run (or resume) the setup. `save` persists a patch of app_config.vrf after each step.
 * `fundEth` is how much ETH to put in the subscription (it pays Chainlink per draw).
 */
export async function setupOnChainDraw(opts: {
  net: VrfNetwork;
  fundEth: string;
  current: VrfSetupState;
  save: (patch: VrfSetupState) => Promise<void>;
}): Promise<{ steps: SetupStep[]; state: VrfSetupState }> {
  const { net } = opts;
  const key = operatorKey();
  const { account, pub, wallet } = clients(net, key);
  const steps: SetupStep[] = [];
  const sameNetwork =
    opts.current.chain_id === net.chain_id &&
    opts.current.coordinator?.toLowerCase() === net.coordinator.toLowerCase();
  let state: VrfSetupState = sameNetwork ? { ...opts.current } : {};
  const persist = async (patch: VrfSetupState) => {
    state = { ...state, ...patch };
    await opts.save(patch);
  };

  const fund = parseEther(opts.fundEth || "0");
  const chainId = await pub.getChainId();
  if (chainId !== net.chain_id)
    throw new Error(`The RPC answered for chain ${chainId}, expected ${net.chain_id}.`);
  const balance = await pub.getBalance({ address: account.address });
  if (balance === 0n)
    throw new Error(
      `The operator wallet ${account.address} has no ETH on ${net.chain}. Send it a little ETH first.`,
    );
  steps.push({
    step: "Operator wallet",
    detail: `${account.address} · ${formatEther(balance)} ETH`,
  });

  // Network settings first, so later steps (and the rest of the app) use the same chain.
  await persist({
    chain: net.chain,
    chain_id: net.chain_id,
    rpc_url: net.rpc_url,
    explorer_url: net.explorer_url,
    coordinator: net.coordinator,
    key_hash: net.key_hash,
    native_payment: true,
    ...(sameNetwork
      ? {}
      : { sub_id: "", sub_funded: false, contract: "", consumer_added: false, enabled: false }),
  });

  // 1. Subscription
  let subId = state.sub_id ? BigInt(state.sub_id) : null;
  if (subId == null) {
    const hash = await wallet.writeContract({
      address: net.coordinator as Hex,
      abi: coordinatorAbi,
      functionName: "createSubscription",
      chain: undefined,
    });
    const receipt = await mined(pub, hash, "Creating the VRF subscription");
    const [created] = parseEventLogs({
      abi: coordinatorAbi,
      eventName: "SubscriptionCreated",
      logs: receipt.logs,
    });
    if (!created) throw new Error("Subscription created but its id wasn't in the receipt");
    subId = created.args.subId;
    await persist({ sub_id: subId.toString() });
    steps.push({ step: "VRF subscription created", detail: `id ${subId}`, tx: hash });
  } else steps.push({ step: "VRF subscription", detail: `id ${subId} (already created)` });

  // 2. Fund it (ETH, since the contract pays Chainlink in native ETH)
  if (fund > 0n && !state.sub_funded) {
    const hash = await wallet.writeContract({
      address: net.coordinator as Hex,
      abi: coordinatorAbi,
      functionName: "fundSubscriptionWithNative",
      args: [subId],
      value: fund,
      chain: undefined,
    });
    await mined(pub, hash, "Funding the subscription");
    await persist({ sub_funded: true });
    steps.push({ step: "Subscription funded", detail: `${opts.fundEth} ETH`, tx: hash });
  }

  // 3. Deploy GotchaVRF (operator = this server wallet; owner = the same wallet)
  let contract = /^0x[0-9a-fA-F]{40}$/.test(state.contract ?? "") ? (state.contract as Hex) : null;
  if (!contract) {
    const hash = await wallet.deployContract({
      abi: constructorAbi,
      bytecode: GOTCHA_VRF_BYTECODE,
      args: [
        net.coordinator as Hex,
        subId,
        net.key_hash as Hex,
        3,
        100_000,
        100_000,
        true,
        account.address,
      ],
      chain: undefined,
    });
    const receipt = await mined(pub, hash, "Deploying the draw contract");
    if (!receipt.contractAddress)
      throw new Error("Deployment mined but no contract address was returned");
    contract = receipt.contractAddress;
    await persist({ contract });
    steps.push({ step: "Draw contract deployed", detail: contract, tx: hash });
  } else steps.push({ step: "Draw contract", detail: `${contract} (already deployed)` });

  // 4. Let the contract use the subscription
  const sub = await pub.readContract({
    address: net.coordinator as Hex,
    abi: coordinatorAbi,
    functionName: "getSubscription",
    args: [subId],
  });
  const consumers = (sub[4] as readonly string[]).map((c) => c.toLowerCase());
  if (!consumers.includes(contract.toLowerCase())) {
    const hash = await wallet.writeContract({
      address: net.coordinator as Hex,
      abi: coordinatorAbi,
      functionName: "addConsumer",
      args: [subId, contract],
      chain: undefined,
    });
    await mined(pub, hash, "Adding the contract to the subscription");
    steps.push({
      step: "Contract added to the subscription",
      detail: "Chainlink will answer its draws",
      tx: hash,
    });
  }
  await persist({ consumer_added: true });

  // Sanity check: the contract is wired to this subscription and this operator.
  const [onSub, onOperator] = await Promise.all([
    pub.readContract({
      address: contract,
      abi: parseAbi(["function subscriptionId() view returns (uint256)"]),
      functionName: "subscriptionId",
    }),
    pub.readContract({ address: contract, abi: gotchaVrfAbi, functionName: "operator" }),
  ]);
  if (onSub !== subId || onOperator.toLowerCase() !== account.address.toLowerCase())
    throw new Error(
      "The deployed contract doesn't match this subscription/operator. Check the Chainlink VRF tab.",
    );
  steps.push({
    step: "Checked",
    detail:
      "Contract, subscription and operator match. Next: publish the prize pool, then switch real spins on.",
  });
  return { steps, state };
}

/** Subscription balance and consumers, for the admin VRF tab. */
export async function subscriptionStatus(state: VrfSetupState) {
  if (!state.sub_id || !state.coordinator || !state.rpc_url || !state.chain_id) return null;
  const net = {
    chain: state.chain ?? "base",
    chain_id: state.chain_id,
    rpc_url: state.rpc_url,
    explorer_url: state.explorer_url ?? "",
    coordinator: state.coordinator,
    key_hash: state.key_hash ?? "",
  };
  const pub = createPublicClient({
    chain: defineChain({
      id: net.chain_id,
      name: net.chain,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [net.rpc_url] } },
    }),
    transport: http(net.rpc_url),
  });
  const sub = await pub.readContract({
    address: net.coordinator as Hex,
    abi: coordinatorAbi,
    functionName: "getSubscription",
    args: [BigInt(state.sub_id)],
  });
  let operator: { address: string; eth: string } | null = null;
  try {
    const account = privateKeyToAccount(operatorKey());
    operator = {
      address: account.address,
      eth: formatEther(await pub.getBalance({ address: account.address })),
    };
  } catch {
    /* key not set */
  }
  return {
    subId: state.sub_id,
    nativeBalanceEth: formatEther(sub[1]),
    linkBalance: formatEther(sub[0]),
    requests: Number(sub[2]),
    consumers: sub[4] as readonly string[],
    operator,
  };
}

/** Add ETH to the subscription (pays Chainlink per draw). */
export async function topUpSubscription(state: VrfSetupState, eth: string) {
  if (!state.sub_id || !state.coordinator || !state.rpc_url || !state.chain_id)
    throw new Error("Set up the on-chain draw first");
  const net = {
    chain: state.chain ?? "base",
    chain_id: state.chain_id,
    rpc_url: state.rpc_url,
    explorer_url: state.explorer_url ?? "",
    coordinator: state.coordinator,
    key_hash: state.key_hash ?? "",
  };
  const { pub, wallet } = clients(net, operatorKey());
  const value = parseEther(eth);
  if (value <= 0n) throw new Error("Enter an amount of ETH");
  const hash = await wallet.writeContract({
    address: net.coordinator as Hex,
    abi: coordinatorAbi,
    functionName: "fundSubscriptionWithNative",
    args: [BigInt(state.sub_id)],
    value,
    chain: undefined,
  });
  await mined(pub, hash, "Topping up the subscription");
  return hash;
}
