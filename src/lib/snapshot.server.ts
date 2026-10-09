// Historical NFT snapshot: Transfer-log indexing (non-enumerable ERC-721, any number of tokens) and
// archive-RPC verification of ownerOf at the frozen snapshot block. Never uses latest ownership.
import { createPublicClient, http, parseAbi, parseAbiItem, type Hex, type PublicClient } from "viem";
import { adminDb, getConfigOr, rpc } from "./helpers.server";

export type Collection = {
  id: string;
  label: string;
  edition: string;
  chain_id: number;
  contract: string;
  deploy_block: number | null;
  snapshot_block: number | null;
  snapshot_block_hash: string | null;
  status: string;
  indexed_through_block: number | null;
};

type SnapshotCfg = { archive_rpc_urls?: Record<string, string>; index_chunk_blocks?: number };

const erc721 = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

export async function archiveClient(chainId: number): Promise<PublicClient> {
  const cfg = await getConfigOr<SnapshotCfg>("snapshot", {});
  const url = cfg.archive_rpc_urls?.[String(chainId)];
  if (!url) throw new Error(`No archive RPC configured for chain ${chainId} (Admin → Configuration → snapshot.archive_rpc_urls)`);
  return createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 1 }) }) as PublicClient;
}

/** Checks the RPC serves the right chain and agrees on the snapshot block hash. */
export async function checkSnapshotAnchor(client: PublicClient, c: Collection) {
  const chainId = await client.getChainId();
  if (chainId !== c.chain_id) return { ok: false as const, reason: `archive RPC is on chain ${chainId}, expected ${c.chain_id}` };
  if (c.snapshot_block == null || !c.snapshot_block_hash) return { ok: false as const, reason: "snapshot block not configured" };
  const block = await client.getBlock({ blockNumber: BigInt(c.snapshot_block) });
  if (block.hash?.toLowerCase() !== c.snapshot_block_hash.toLowerCase()) {
    return { ok: false as const, reason: `snapshot block hash mismatch (${block.hash})`, hash: block.hash };
  }
  return { ok: true as const, hash: block.hash.toLowerCase() };
}

/**
 * Index one chunk of Transfer logs (deploy_block .. snapshot_block), oldest first. Call repeatedly
 * until `done`. Only allowed while the collection is still a candidate.
 */
export async function indexCollectionChunk(collectionId: string) {
  const db = await adminDb();
  const { data: c } = await db.from("nft_collections").select("*").eq("id", collectionId).single();
  const col = c as Collection;
  if (col.status === "ready") throw new Error("Collection is ready; its snapshot index is frozen");
  if (col.deploy_block == null || col.snapshot_block == null) throw new Error("Set deploy_block and snapshot_block first");
  const cfg = await getConfigOr<SnapshotCfg>("snapshot", {});
  const chunk = BigInt(Math.max(100, Math.min(cfg.index_chunk_blocks ?? 5000, 100_000)));
  const client = await archiveClient(col.chain_id);
  const anchor = await checkSnapshotAnchor(client, col);
  if (!anchor.ok) throw new Error(anchor.reason);

  const from = BigInt(col.indexed_through_block != null ? col.indexed_through_block + 1 : col.deploy_block);
  const end = BigInt(col.snapshot_block);
  if (from > end) return { done: true, indexed_through: Number(end), transfers: 0 };
  const to = from + chunk - 1n < end ? from + chunk - 1n : end;
  const logs = await client.getLogs({ address: col.contract as Hex, event: transferEvent, fromBlock: from, toBlock: to });
  // Last transfer of each token within this chunk wins (logs are ordered by block, then log index).
  const latest = new Map<string, { owner: string; block: bigint }>();
  for (const l of logs) {
    if (l.args.tokenId == null || !l.args.to || l.blockNumber == null) continue;
    latest.set(l.args.tokenId.toString(), { owner: l.args.to.toLowerCase(), block: l.blockNumber });
  }
  const rows = [...latest.entries()].map(([token_id, v]) => ({ collection_id: col.id, token_id, owner: v.owner, last_transfer_block: Number(v.block) }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("nft_snapshot_owners").upsert(rows.slice(i, i + 500), { onConflict: "collection_id,token_id" });
    if (error) throw new Error(error.message);
  }
  const { error } = await db.from("nft_collections").update({ indexed_through_block: Number(to), indexed_at: new Date().toISOString() }).eq("id", col.id);
  if (error) throw new Error(error.message);
  return { done: to >= end, indexed_through: Number(to), transfers: logs.length, tokens_touched: rows.length };
}

/** Verify one claim with ownerOf at the snapshot block. Outages leave it open. */
export async function verifyClaim(claimId: string) {
  const db = await adminDb();
  const { data: cl } = await db.from("nft_snapshot_claims").select("*").eq("id", claimId).single();
  const { data: c } = await db.from("nft_collections").select("*").eq("id", cl.collection_id).single();
  let client: PublicClient;
  try {
    client = await archiveClient((c as Collection).chain_id);
  } catch (e) {
    return rpc("record_snapshot_verification", { _claim: claimId, _owner: null, _block_hash: null, _unavailable: true, _error: (e as Error).message });
  }
  try {
    const anchor = await checkSnapshotAnchor(client, c as Collection);
    if (!anchor.ok) {
      return rpc("record_snapshot_verification", { _claim: claimId, _owner: null, _block_hash: "hash" in anchor ? anchor.hash ?? null : null, _unavailable: !("hash" in anchor), _error: anchor.reason });
    }
    const owner = await client.readContract({
      address: (c as Collection).contract as Hex,
      abi: erc721,
      functionName: "ownerOf",
      args: [BigInt(cl.token_id)],
      blockNumber: BigInt((c as Collection).snapshot_block!),
    });
    return rpc("record_snapshot_verification", { _claim: claimId, _owner: owner.toLowerCase(), _block_hash: anchor.hash, _unavailable: false, _error: null });
  } catch (e) {
    const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
    // Any RPC failure (including a revert, which an RPC without archive state can also produce) keeps the
    // claim open. Only a definite ownerOf answer decides it; an admin can reject a claim that can't resolve.
    return rpc("record_snapshot_verification", { _claim: claimId, _owner: null, _block_hash: null, _unavailable: true, _error: msg.slice(0, 300) });
  }
}

/** Player flow: find snapshot tokens held by the player's verified wallets, claim and verify them. */
export async function claimForUser(userId: string, collectionId: string) {
  const db = await adminDb();
  const { data: wallets } = await db.from("wallets").select("address").eq("user_id", userId);
  const addrs = ((wallets ?? []) as { address: string }[]).map((w) => w.address.toLowerCase());
  if (!addrs.length) throw new Error("Verify a wallet first");
  const tokens: { token_id: string; wallet: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("nft_snapshot_owners")
      .select("token_id, owner")
      .eq("collection_id", collectionId)
      .in("owner", addrs)
      .order("token_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { token_id: string; owner: string }[];
    tokens.push(...page.map((t) => ({ token_id: String(t.token_id), wallet: t.owner })));
    if (page.length < 1000) break;
  }
  let created = 0;
  let already = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const r = await rpc<{ created: number; already_claimed: number }>("submit_snapshot_claims", { _user: userId, _collection: collectionId, _tokens: tokens.slice(i, i + 500) });
    created += r.created;
    already += r.already_claimed;
  }
  const { data: open } = await db.from("nft_snapshot_claims").select("id").eq("user_id", userId).eq("collection_id", collectionId).in("status", ["pending", "unavailable"]).limit(300);
  for (const o of (open ?? []) as { id: string }[]) await verifyClaim(o.id);
  return { found: tokens.length, created, already_claimed: already };
}

export async function retryOpenClaims(limit = 50) {
  const db = await adminDb();
  const { data } = await db.from("nft_snapshot_claims").select("id").in("status", ["pending", "unavailable"]).order("submitted_at").limit(limit);
  let n = 0;
  for (const r of (data ?? []) as { id: string }[]) {
    await verifyClaim(r.id);
    n++;
  }
  return { retried: n };
}
