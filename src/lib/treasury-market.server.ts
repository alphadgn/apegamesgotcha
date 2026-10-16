// Gotcha Treasury, server only: chains, the keeper wallet, OpenSea (floor listings + Seaport fulfillment) and
// Relay (APE on ApeChain → ETH / tokens on other chains). Secrets: KEEPER_PRIVATE_KEY, OPENSEA_API_KEY,
// RELAY_API_KEY (optional), ETH_RPC_URL / ROBINHOOD_RPC_URL (optional private RPCs). Never logged.
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEther,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainDef, resilientTransport } from "./rpc.server";
import { SPLITTER_ABI, SPLITTER_CHAINS, type SplitterChainId } from "@/contracts/splitter";
import type { TreasurySettings } from "./treasury-settings";

export const NATIVE = "0x0000000000000000000000000000000000000000";
export const ETHEREUM_ID = 1;

// ---------- keeper wallet ----------

export function keeperAccount() {
  const raw = process.env["KEEPER_PRIVATE_KEY"]?.trim();
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return null;
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

// ---------- chains ----------

export type ChainCtx = { id: number; name: string; rpc: string | null; privateEnv?: string };

export function apeChain(id: SplitterChainId): ChainCtx {
  return { id, name: SPLITTER_CHAINS[id].name, rpc: SPLITTER_CHAINS[id].rpc };
}
export function ethChain(s: TreasurySettings): ChainCtx {
  return {
    id: ETHEREUM_ID,
    name: "Ethereum",
    rpc: s.eth_rpc_url || null,
    privateEnv: "ETH_RPC_URL",
  };
}
export function rhChain(s: TreasurySettings): ChainCtx {
  return {
    id: s.robinhood_chain_id,
    name: "Robinhood Chain",
    rpc: s.robinhood_rpc_url || null,
    privateEnv: "ROBINHOOD_RPC_URL",
  };
}

const opts = (c: ChainCtx) => (c.privateEnv ? { privateEnv: c.privateEnv } : undefined);
export function reader(c: ChainCtx) {
  return createPublicClient({
    chain: chainDef(c.id, c.name, c.rpc, opts(c)),
    transport: resilientTransport(c.id, c.rpc, opts(c)),
  });
}
export function writer(c: ChainCtx) {
  const account = keeperAccount();
  if (!account) throw new Error("KEEPER_PRIVATE_KEY isn't set (Lovable → Secrets).");
  return createWalletClient({
    account,
    chain: chainDef(c.id, c.name, c.rpc, opts(c)),
    transport: resilientTransport(c.id, c.rpc, opts(c)),
  });
}

// ---------- splitter ----------

export type BucketState = {
  name: string;
  recipient: string;
  bps: number;
  mode: number;
  balance: bigint;
  target: bigint;
};

export async function readSplitter(chainId: SplitterChainId, address: string) {
  const pub = reader(apeChain(chainId));
  const a = getAddress(address);
  const r = (functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: a, abi: SPLITTER_ABI, functionName, args }) as Promise<unknown>;
  const [buckets, totalReceived, totalTracked, owner, keeper, balance] = await Promise.all([
    r("getBuckets") as Promise<BucketState[]>,
    r("totalReceived") as Promise<bigint>,
    r("totalTracked") as Promise<bigint>,
    r("owner") as Promise<string>,
    r("keeper") as Promise<string>,
    pub.getBalance({ address: a }),
  ]);
  const ready = await Promise.all(
    buckets.map((_, i) => r("readyToBuy", [BigInt(i)]) as Promise<boolean>),
  );
  return {
    buckets: buckets.map((b, i) => ({
      ...b,
      bps: Number(b.bps),
      mode: Number(b.mode),
      ready: ready[i]!,
    })),
    totalReceived,
    totalTracked,
    owner: owner.toLowerCase(),
    keeper: keeper.toLowerCase(),
    balance,
  };
}

/** Sends a splitter call from the keeper wallet and waits for it (up to 45 s). */
export async function splitterTx(
  chainId: SplitterChainId,
  address: string,
  functionName: string,
  args: unknown[] = [],
) {
  const c = apeChain(chainId);
  const w = writer(c);
  const pub = reader(c);
  const { request } = await pub.simulateContract({
    account: w.account,
    address: getAddress(address),
    abi: SPLITTER_ABI,
    functionName,
    args,
  });
  const hash = await w.writeContract(request as never);
  const receipt = await pub
    .waitForTransactionReceipt({ hash, timeout: 45_000, pollingInterval: 1500 })
    .catch(() => null);
  return { hash, receipt };
}

/** The Released(bucket, to, amount, target) event in a receipt, if any. */
export function releasedAmount(
  logs: { data: Hex; topics: Hex[] }[],
  bucket: number,
): bigint | null {
  for (const l of logs) {
    try {
      const ev = decodeEventLog({
        abi: SPLITTER_ABI,
        data: l.data,
        topics: l.topics as [Hex, ...Hex[]],
      });
      const args = ev.args as unknown as { bucket: bigint; amount: bigint };
      if (ev.eventName === "Released" && Number(args.bucket) === bucket) return args.amount;
    } catch {
      /* other log */
    }
  }
  return null;
}

// ---------- OpenSea ----------

const OS = "https://api.opensea.io/api/v2";
function osHeaders() {
  const key = process.env["OPENSEA_API_KEY"]?.trim();
  if (!key) throw new Error("OPENSEA_API_KEY isn't set (Lovable → Secrets).");
  return { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" };
}

export type Listing = {
  hash: string;
  chain: string;
  protocol: string;
  priceWei: bigint;
  contract: string;
  tokenId: string;
};

/** Cheapest native-currency listing in a collection (null when none). */
export async function bestListing(slug: string): Promise<Listing | null> {
  const res = await fetch(`${OS}/listings/collection/${encodeURIComponent(slug)}/best?limit=20`, {
    headers: osHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenSea listings for ${slug} failed (${res.status}).`);
  const body = (await res.json()) as {
    listings?: {
      order_hash: string;
      chain: string;
      protocol_address: string;
      price?: { current?: { currency?: string; decimals?: number; value?: string } };
      protocol_data?: {
        parameters?: {
          offer?: { token: string; identifierOrCriteria: string; itemType?: number }[];
          consideration?: { itemType?: number }[];
        };
      };
    }[];
  };
  const ok = (body.listings ?? [])
    .filter((l) => {
      const p = l.price?.current;
      // Native currency only (ETH): every consideration item is native (itemType 0), 18 decimals.
      const native = (l.protocol_data?.parameters?.consideration ?? []).every(
        (c) => (c.itemType ?? 0) === 0,
      );
      return (
        p?.value &&
        /^\d+$/.test(p.value) &&
        (p.decimals ?? 18) === 18 &&
        native &&
        l.protocol_data?.parameters?.offer?.[0]
      );
    })
    .map((l) => ({
      hash: l.order_hash,
      chain: l.chain,
      protocol: l.protocol_address,
      priceWei: BigInt(l.price!.current!.value!),
      contract: l.protocol_data!.parameters!.offer![0]!.token.toLowerCase(),
      tokenId: String(l.protocol_data!.parameters!.offer![0]!.identifierOrCriteria),
    }))
    .sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : 0));
  return ok[0] ?? null;
}

// Seaport 1.6 functions the fulfillment API may return (named, so input_data can be matched by name).
const OFFER_ITEM =
  "(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)";
const CONSIDERATION_ITEM =
  "(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)";
const ORDER_PARAMETERS = `(address offerer,address zone,${OFFER_ITEM}[] offer,${CONSIDERATION_ITEM}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
const BASIC =
  "(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,(uint256 amount,address recipient)[] additionalRecipients,bytes signature)";
export const SEAPORT_ABI = parseAbi([
  `function fulfillBasicOrder_efficient_6GL6yc(${BASIC} parameters) payable returns (bool fulfilled)`,
  `function fulfillBasicOrder(${BASIC} parameters) payable returns (bool fulfilled)`,
  `function fulfillOrder((${ORDER_PARAMETERS} parameters,bytes signature) order,bytes32 fulfillerConduitKey) payable returns (bool fulfilled)`,
  `function fulfillAdvancedOrder((${ORDER_PARAMETERS} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData) advancedOrder,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns (bool fulfilled)`,
]) as Abi;

type AbiParam = { name?: string; type: string; components?: readonly AbiParam[] };
/** JSON from the API → viem values (numbers as BigInt, tuples by component name). */
function coerce(p: AbiParam, v: unknown): unknown {
  if (p.type.endsWith("[]")) {
    const inner = { ...p, type: p.type.slice(0, -2) };
    return ((v ?? []) as unknown[]).map((x) => coerce(inner, x));
  }
  if (p.type === "tuple") {
    const o = (v ?? {}) as Record<string, unknown>;
    return Object.fromEntries((p.components ?? []).map((c) => [c.name!, coerce(c, o[c.name!])]));
  }
  if (/^u?int\d*$/.test(p.type)) return BigInt(String(v ?? "0"));
  if (p.type === "bool") return v === true || v === "true";
  return v;
}

/** Ready-to-send transaction for buying a listing (fulfiller = the keeper wallet). */
export async function fulfillListing(l: Listing, fulfiller: string) {
  const res = await fetch(`${OS}/listings/fulfillment_data`, {
    method: "POST",
    headers: osHeaders(),
    body: JSON.stringify({
      listing: { hash: l.hash, chain: l.chain, protocol_address: l.protocol },
      fulfiller: { address: fulfiller },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok)
    throw new Error(
      `OpenSea fulfillment failed (${res.status}): ${(await res.text()).slice(0, 160)}`,
    );
  const body = (await res.json()) as {
    fulfillment_data?: {
      transaction?: {
        function?: string;
        to: string;
        value?: string | number;
        input_data?: Record<string, unknown>;
      };
    };
  };
  const tx = body.fulfillment_data?.transaction;
  if (!tx?.to || !tx.function) throw new Error("OpenSea returned no transaction.");
  const name = tx.function.split("(")[0]!;
  const fn = (
    SEAPORT_ABI as readonly { type: string; name?: string; inputs?: readonly AbiParam[] }[]
  ).find((x) => x.type === "function" && x.name === name);
  if (!fn) throw new Error(`Unsupported Seaport function ${name}.`);
  const input = tx.input_data ?? {};
  const args = (fn.inputs ?? []).map((p) => coerce(p, input[p.name!]));
  const data = encodeFunctionData({ abi: SEAPORT_ABI, functionName: name, args } as never);
  return { to: getAddress(tx.to), value: BigInt(String(tx.value ?? "0")), data };
}

export const ERC721_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

// ---------- Relay ----------

const RELAY = "https://api.relay.link";
function relayHeaders() {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env["RELAY_API_KEY"]?.trim();
  if (key) h["x-api-key"] = key;
  return h;
}

export type RelayStepItem = {
  status: string;
  data: { to: string; data: string; value: string; chainId: number; gas?: string };
};
export type RelayQuote = {
  requestId: string;
  steps: { id: string; kind: string; requestId?: string; items: RelayStepItem[] }[];
  amountIn: bigint;
  amountOut: bigint;
};

export async function relayQuote(q: {
  user: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency?: string;
  destinationCurrency?: string;
  amount: bigint;
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
  recipient?: string;
  slippageBps?: number;
}): Promise<RelayQuote> {
  const res = await fetch(`${RELAY}/quote/v2`, {
    method: "POST",
    headers: relayHeaders(),
    body: JSON.stringify({
      user: q.user,
      originChainId: q.originChainId,
      destinationChainId: q.destinationChainId,
      originCurrency: q.originCurrency ?? NATIVE,
      destinationCurrency: q.destinationCurrency ?? NATIVE,
      amount: q.amount.toString(),
      tradeType: q.tradeType,
      ...(q.recipient ? { recipient: q.recipient } : {}),
      ...(q.slippageBps != null ? { slippageTolerance: String(q.slippageBps) } : {}),
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    steps?: RelayQuote["steps"];
    details?: { currencyIn?: { amount?: string }; currencyOut?: { amount?: string } };
  } | null;
  if (!res.ok || !body?.steps?.length)
    throw new Error(`Relay quote failed (${res.status}): ${body?.message ?? "no route"}`);
  const requestId = body.steps.find((s) => s.requestId)?.requestId;
  if (!requestId) throw new Error("Relay quote had no request ID.");
  return {
    requestId,
    steps: body.steps,
    amountIn: BigInt(body.details?.currencyIn?.amount ?? "0"),
    amountOut: BigInt(body.details?.currencyOut?.amount ?? "0"),
  };
}

/** Sends every transaction step of a quote from the keeper wallet (origin chain). Returns the last tx hash. */
export async function relayExecute(quote: RelayQuote, origin: ChainCtx) {
  const w = writer(origin);
  let last: Hex | null = null;
  for (const step of quote.steps) {
    if (step.kind !== "transaction")
      throw new Error(`Relay step "${step.id}" needs a signature; not supported for native APE.`);
    for (const item of step.items) {
      if (item.status === "complete") continue;
      if (item.data.chainId !== origin.id)
        throw new Error(`Relay step on chain ${item.data.chainId}, expected ${origin.id}.`);
      last = await w.sendTransaction({
        to: getAddress(item.data.to),
        data: (item.data.data || "0x") as Hex,
        value: BigInt(item.data.value || "0"),
        chain: w.chain,
        account: w.account!,
      });
    }
  }
  return last;
}

/** Relay's status for a request: waiting / pending / success / failure / refund / unknown. */
export async function relayStatus(requestId: string) {
  const res = await fetch(`${RELAY}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, {
    headers: relayHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { status: "unknown", txHashes: [] as string[] };
  if (!res.ok) throw new Error(`Relay status failed (${res.status}).`);
  const b = (await res.json()) as { status?: string; txHashes?: string[] };
  return { status: b.status ?? "unknown", txHashes: b.txHashes ?? [] };
}

export const pct = (v: bigint, p: number) => (v * BigInt(Math.round(p * 100))) / 10000n;
export const eth = (s: string) => parseEther(s || "0");
