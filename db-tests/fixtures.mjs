// Shared setup for the database tests.
import { randomUUID } from "node:crypto";

export const CONTRACT = "0x" + "c".repeat(40);
export const CHAIN = 84532;

/** Make the seeded prize pool valid (classified, costed, indexed) like an admin would. */
export async function cleanPool(db) {
  await db.q(`update prizes set kind = 'points_only', unit_cost_usd = 0, cost_verified = true, onchain_index = 0 where name = 'Banana Chip'`);
  await db.q(`update prizes set kind = 'points_only', unit_cost_usd = 0, cost_verified = true, onchain_index = 1 where name = 'Silver Crate'`);
  await db.q(`update prizes set kind = 'fulfillment_required', unit_cost_usd = 10, cost_verified = true, stock_verified = true, onchain_index = 2 where name = 'Gold Crate'`);
  await db.q(`update prizes set kind = 'fulfillment_required', unit_cost_usd = 100, cost_verified = true, stock_verified = true, onchain_index = 3 where name = 'Charleston VIP Pass'`);
  return Object.fromEntries((await db.q(`select name, id from prizes`)).map((r) => [r.name, r.id]));
}

export async function makeAdmin(db) {
  const id = await db.createUser(`admin-${randomUUID().slice(0, 6)}@example.com`);
  await db.q(`insert into user_roles(user_id, role) values ($1, 'admin')`, [id]);
  return id;
}

/** Creates a draft season and activates it through the real activation function. */
export async function activeSeason(db, admin, { slug = "s1", rules, startsAgo = "1 hour", endsIn = "1 day", collectionIds = [] } = {}) {
  const r = rules ?? (await db.one(`select default_season_rules() r`)).r;
  if (!collectionIds.length) r.points.nft_snapshot_per_token = "0";
  const s = await db.one(
    `insert into seasons(slug, name, starts_at, ends_at, settlement_deadline, rules, snapshot_config, created_by)
     values ($1, $1, now() - $2::interval, now() + $3::interval, now() + $3::interval + interval '2 days', $4, $5, $6) returning id`,
    [slug, startsAgo, endsIn, JSON.stringify(r), JSON.stringify({ collection_ids: collectionIds }), admin],
  );
  await db.rpc("activate_season", [s.id, admin]);
  return s.id;
}

export async function giveCredits(db, user, n, source = "purchase") {
  for (let i = 0; i < n; i++) {
    await db.q(`insert into spin_credits(user_id, source, ref, funding) values ($1, $2, $3, 'purchase')`, [user, source, randomUUID()]);
  }
}

export const hex = (n = 64) => "0x" + Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/** Reserve -> sign -> broadcast -> confirm a batch. Returns { batchId, spinIds, txHash, requestId }. */
export async function confirmedBatch(db, user, count = 1, { blockTime = null, key = randomUUID() } = {}) {
  const [{ reserve_draw_batch: res }] = await db.rpc("reserve_draw_batch", [user, count, key, CHAIN, CONTRACT, 1]);
  const txHash = hex();
  const nonce = Number((await db.one(`select count(*)::int n from draw_submissions`)).n);
  await db.rpc("record_draw_signed", [res.batch_id, "0x" + "a".repeat(40), nonce, txHash, "0x" + "ab".repeat(60)]);
  await db.rpc("record_draw_broadcast", [txHash, null]);
  const requestId = String(Math.floor(Math.random() * 1e12));
  await db.rpc("confirm_draw_request", [txHash, requestId, 100, hex(), blockTime ?? new Date(), 3, res.spin_ids]);
  return { batchId: res.batch_id, spinIds: res.spin_ids, txHash, requestId };
}
