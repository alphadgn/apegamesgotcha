import { addr, createUser, rpc, type Sql } from "./harness";

export const CHAIN_ID = 84532;
export const CONTRACT = addr(0xc0ffee);
export const ADMIN_ACTOR = "00000000-0000-0000-0000-00000000a0a0";

export async function prizeIds(sql: Sql) {
  const rows = await sql<
    { id: string; name: string; rarity: string; weight: number; inventory: number | null }[]
  >`
    select id, name, rarity, weight, inventory from public.prizes order by created_at, id`;
  const by = (n: string) => rows.find((r) => r.name === n)!;
  return {
    all: rows,
    banana: by("Banana Chip"),
    silver: by("Silver Crate"),
    gold: by("Gold Crate"),
    vip: by("Charleston VIP Pass"),
  };
}

/** Classify the seeded prizes and record verified costs/stock so draws are economically ready. */
export async function verifyEconomics(sql: Sql) {
  const p = await prizeIds(sql);
  await rpc(sql, "admin_upsert_prize", {
    _id: p.banana.id,
    _name: p.banana.name,
    _rarity: "common",
    _weight: 600,
    _inventory: null,
    _active: true,
    _fulfillment_type: "points_only",
    _actor: ADMIN_ACTOR,
  });
  await rpc(sql, "admin_upsert_prize", {
    _id: p.silver.id,
    _name: p.silver.name,
    _rarity: "rare",
    _weight: 280,
    _inventory: null,
    _active: true,
    _fulfillment_type: "digital_free",
    _actor: ADMIN_ACTOR,
  });
  await rpc(sql, "admin_upsert_prize", {
    _id: p.gold.id,
    _name: p.gold.name,
    _rarity: "epic",
    _weight: 100,
    _inventory: 500,
    _active: true,
    _fulfillment_type: "fulfillment_required",
    _actor: ADMIN_ACTOR,
  });
  await rpc(sql, "admin_upsert_prize", {
    _id: p.vip.id,
    _name: p.vip.name,
    _rarity: "legendary",
    _weight: 20,
    _inventory: 20,
    _active: true,
    _fulfillment_type: "fulfillment_required",
    _actor: ADMIN_ACTOR,
  });
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role service_role");
    await tx`insert into public.prize_economics (prize_id, acquisition_usd, fulfillment_usd, shipping_usd, cost_verified_at, cost_evidence, stock_verified_qty, stock_verified_at, stock_evidence)
             values (${p.gold.id}, 10, 1, 4, now(), 'invoice #1', 500, now(), 'warehouse count'),
                    (${p.vip.id}, 300, 0, 0, now(), 'ticket invoice', 20, now(), 'ticket allocation letter')`;
    await tx`insert into public.operating_costs (category, basis, description, amount_usd, verified_at, evidence)
             values ('gas', 'per_draw', 'Base gas per request', 0.02, now(), 'basescan avg'),
                    ('vrf', 'per_draw', 'Chainlink VRF fee', 0.25, now(), 'subscription history')`;
  });
  return p;
}

export async function enableVrf(sql: Sql, contract = CONTRACT, chainId = CHAIN_ID) {
  await sql`update public.app_config set value = value || ${sql.json({ enabled: true, contract, chain_id: chainId, min_confirmations: 3 } as never)} where key = 'vrf'`;
}

/** Publish the pool "on-chain" (the test plays the contract: confirms exactly what was prepared). */
export async function publishPool(
  sql: Sql,
  chainRemaining: bigint[] = [],
  chainVersion: number | null = null,
  version = 1,
  contract = CONTRACT,
) {
  const [pub] = await rpc<{ id: string; weights: string[]; remaining: string[] }>(
    sql,
    "prepare_pool_publication",
    {
      _chain_id: CHAIN_ID,
      _contract: contract,
      _chain_pool_version: chainVersion,
      _chain_remaining: chainRemaining.map(String),
      _chain_pending: 0,
      _actor: ADMIN_ACTOR,
    },
  );
  await rpc(sql, "mark_pool_publication_sent", {
    _publication_id: pub!.id,
    _tx_hash: `0x${"ab".repeat(31)}${version.toString(16).padStart(2, "0")}`,
  });
  const [c] = await rpc<{ pool_version: string }>(sql, "confirm_pool_publication", {
    _publication_id: pub!.id,
    _pool_version: version,
    _chain_weights: pub!.weights,
    _chain_remaining: pub!.remaining,
    _actor: ADMIN_ACTOR,
  });
  return { publication: pub!, version: Number(c!.pool_version) };
}

export async function activeSeason(
  sql: Sql,
  opts: {
    rules?: Record<string, unknown>;
    startOffsetSec?: number;
    endOffsetSec?: number;
    slug?: string;
  } = {},
) {
  const now = Date.now();
  const starts = new Date(now + (opts.startOffsetSec ?? -3600) * 1000);
  const ends = new Date(now + (opts.endOffsetSec ?? 86400) * 1000);
  const deadline = new Date(ends.getTime() + 2 * 86400 * 1000);
  const [s] = await rpc<{ id: string }>(sql, "create_season_draft", {
    _slug: opts.slug ?? `s-${Math.random().toString(36).slice(2, 8)}`,
    _name: "Test Season",
    _starts_at: starts,
    _ends_at: ends,
    _settlement_deadline: deadline,
    _rules: { nft_snapshot_points: 0, ...(opts.rules ?? {}) },
    _notes: null,
    _actor: ADMIN_ACTOR,
  });
  const [a] = await rpc<{ id: string; rule_version_id: string; starts_at: Date; ends_at: Date }>(
    sql,
    "activate_season",
    { _season_id: s!.id, _actor: ADMIN_ACTOR },
  );
  return a!;
}

/** A paid purchase of `n` spins (5/10/15/20) for the user. */
export async function buySpins(sql: Sql, userId: string, n: 5 | 10 | 15 | 20 = 5) {
  const [p] = await sql<
    { id: string }[]
  >`insert into public.spin_purchases (user_id, quantity, price_wei, chain_id, treasury, price_usd)
    values (${userId}, ${n}, 1000, 33139, ${addr(0x7)}, ${n}) returning id`;
  const tx = `0x${p!.id.replace(/-/g, "").padEnd(64, "0")}`;
  await rpc(sql, "complete_spin_purchase", {
    _purchase_id: p!.id,
    _tx_hash: tx,
    _payer: addr(0x99),
  });
  return p!.id;
}

let nonceCounter = 1;
let txCounter = 1;

/** Reserve → sign → broadcast → confirmed receipt, like the server does. Returns batch + spin ids. */
export async function drawConfirmed(
  sql: Sql,
  userId: string,
  count: number,
  poolVersion: number,
  opts: { blockTime?: Date; key?: string; requestId?: string } = {},
) {
  const [b] = await rpc<{ id: string; spin_ids: string[] }>(sql, "begin_draw_batch", {
    _user_id: userId,
    _idempotency_key: opts.key ?? `k${Math.random().toString(36).slice(2, 12)}`,
    _count: count,
    _chain_id: CHAIN_ID,
    _contract: CONTRACT,
    _pool_version: poolVersion,
  });
  const txHash = `0x${(txCounter++).toString(16).padStart(64, "0")}`;
  await rpc(sql, "record_signed_submission", {
    _batch_id: b!.id,
    _chain_id: CHAIN_ID,
    _operator: addr(0x0b),
    _nonce: nonceCounter++,
    _tx_hash: txHash,
    _raw_tx: "0x02f8",
  });
  await rpc(sql, "mark_submission_broadcast", { _tx_hash: txHash, _error: null });
  const requestId = opts.requestId ?? String(1000 + txCounter);
  await rpc(sql, "record_request_receipt", {
    _tx_hash: txHash,
    _success: true,
    _block_number: 100 + txCounter,
    _block_hash: `0x${(9000 + txCounter).toString(16).padStart(64, "0")}`,
    _block_time: opts.blockTime ?? new Date(),
    _confirmations: 5,
    _min_confirmations: 3,
    _request_id: requestId,
    _spin_ids: b!.spin_ids,
  });
  return { batchId: b!.id, spinIds: b!.spin_ids, txHash, requestId };
}

export async function settle(sql: Sql, spinId: string, prizeIndex: number, requestId: string) {
  const [s] = await rpc<{
    status: string;
    points: number;
    scored: boolean;
    participation_points: string;
    bonus_points: string;
  }>(sql, "settle_spin", {
    _spin_id: spinId,
    _chain_status: 2,
    _prize_index: prizeIndex,
    _random_word: "42",
    _request_id: requestId,
    _evidence: { test: true },
  });
  return s!;
}

export async function newPlayer(sql: Sql) {
  return createUser(sql);
}
