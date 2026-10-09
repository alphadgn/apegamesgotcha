// Historical NFT recognition.
//  * indexSnapshot: rebuild who owned every token at the snapshot block from Transfer logs (works for
//    non-enumerable ERC-721 and any number of holdings), in contiguous, resumable block ranges.
//  * verifyClaims: confirm each claim with ownerOf(token) AT the snapshot block through an archive RPC,
//    after checking the chain id and the snapshot block hash. Outages leave claims unavailable (retry later);
//    nothing ever falls back to the latest owner.
import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import type { Db } from "./db-rpc";

export type Collection = {
  id: string;
  chain_id: number;
  contract: string;
  edition: string;
  status: string;
  snapshot_block: string | number | null;
  snapshot_block_hash: string | null;
  index_from_block: string | number;
  index_cursor_block: string | number | null;
};

const erc721 = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

/** Archive RPC for a chain: ARCHIVE_RPC_URL_<chainId> secret first (provider keys live there), else config. */
export function archiveClient(
  chainId: number,
  configured?: Record<string, string>,
): PublicClient | null {
  const url = process.env[`ARCHIVE_RPC_URL_${chainId}`] ?? configured?.[String(chainId)];
  if (!url) return null;
  return createPublicClient({
    transport: http(url, { timeout: 20_000, retryCount: 1 }),
    cacheTime: 0,
  }) as PublicClient;
}

async function checkSnapshotAnchor(pub: PublicClient, c: Collection) {
  const chainId = await pub.getChainId();
  if (chainId !== c.chain_id)
    throw new SnapshotUnavailable(`RPC is on chain ${chainId}, collection is on ${c.chain_id}`);
  if (c.snapshot_block == null || !c.snapshot_block_hash)
    throw new Error("Snapshot block not configured");
  const block = await pub.getBlock({ blockNumber: BigInt(c.snapshot_block) }).catch((e: Error) => {
    throw new SnapshotUnavailable(`Can't read snapshot block: ${e.message.slice(0, 120)}`);
  });
  if (block.hash?.toLowerCase() !== c.snapshot_block_hash.toLowerCase()) {
    throw new SnapshotUnavailable(`Snapshot block hash mismatch (chain says ${block.hash})`);
  }
  return block;
}

export class SnapshotUnavailable extends Error {}

/** Index Transfer logs up to the snapshot block. Call repeatedly; each call advances `maxRanges` ranges. */
export async function indexSnapshot(
  db: Db,
  pub: PublicClient,
  c: Collection,
  opts: { rangeSize?: number; maxRanges?: number } = {},
) {
  if (c.status !== "candidate") throw new Error("Only candidate collections are indexed");
  await checkSnapshotAnchor(pub, c);
  const snap = BigInt(c.snapshot_block!);
  const size = BigInt(opts.rangeSize ?? 5_000);
  let from =
    c.index_cursor_block == null ? BigInt(c.index_from_block) : BigInt(c.index_cursor_block) + 1n;
  let ranges = 0;
  let tokens = 0;
  while (from <= snap && ranges < (opts.maxRanges ?? 20)) {
    const to = from + size - 1n > snap ? snap : from + size - 1n;
    const logs = await pub.getLogs({
      address: c.contract as Hex,
      event: transferEvent,
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    const rows = logs.map((l) => ({
      token_id: l.args.tokenId.toString(),
      to: l.args.to.toLowerCase(),
      block: Number(l.blockNumber),
      log_index: Number(l.logIndex),
    }));
    tokens += rows.length;
    await db.rpc("apply_snapshot_transfers", {
      _collection_id: c.id,
      _from_block: Number(from),
      _to_block: Number(to),
      _rows: rows,
      _complete: to === snap,
    });
    from = to + 1n;
    ranges++;
  }
  return { done: from > snap, nextBlock: Number(from), transfersApplied: tokens };
}

type Claim = { id: string; collection_id: string; token_id: string; owner_address: string };

/** Verify claims at the snapshot block. Returns counts by outcome. */
export async function verifyClaims(
  db: Db,
  pub: PublicClient | null,
  c: Collection,
  claims: Claim[],
) {
  const out = { verified: 0, rejected: 0, unavailable: 0 };
  const unavailable = async (cl: Claim, why: string) => {
    await db.rpc("resolve_snapshot_claim", {
      _claim_id: cl.id,
      _outcome: "unavailable",
      _snapshot_owner: null,
      _evidence: {},
      _error: why.slice(0, 300),
    });
    out.unavailable++;
  };
  if (!pub) {
    for (const cl of claims) await unavailable(cl, "No archive RPC configured for this chain");
    return out;
  }
  let block;
  try {
    block = await checkSnapshotAnchor(pub, c);
  } catch (e) {
    for (const cl of claims) await unavailable(cl, (e as Error).message);
    return out;
  }
  const evidence = {
    chain_id: c.chain_id,
    block_number: Number(c.snapshot_block),
    block_hash: block.hash!.toLowerCase(),
  };
  for (const cl of claims) {
    let owner: string;
    try {
      owner = (
        await pub.readContract({
          address: c.contract as Hex,
          abi: erc721,
          functionName: "ownerOf",
          args: [BigInt(cl.token_id)],
          blockNumber: BigInt(c.snapshot_block!),
        })
      ).toLowerCase();
    } catch (e) {
      const msg = (e as Error).message;
      // A revert means the token didn't exist (or was burned) at the snapshot; anything else is an outage.
      if (
        /revert|nonexistent|invalid token/i.test(msg) &&
        !/missing trie node|header not found|state.*not available|timeout|fetch failed/i.test(msg)
      ) {
        await db.rpc("resolve_snapshot_claim", {
          _claim_id: cl.id,
          _outcome: "rejected",
          _snapshot_owner: null,
          _evidence: evidence,
          _error: "token did not exist at the snapshot",
        });
        out.rejected++;
      } else {
        await unavailable(cl, msg);
      }
      continue;
    }
    if (owner === cl.owner_address.toLowerCase()) {
      await db.rpc("resolve_snapshot_claim", {
        _claim_id: cl.id,
        _outcome: "verified",
        _snapshot_owner: owner,
        _evidence: evidence,
        _error: null,
      });
      out.verified++;
    } else {
      await db.rpc("resolve_snapshot_claim", {
        _claim_id: cl.id,
        _outcome: "rejected",
        _snapshot_owner: owner,
        _evidence: { ...evidence, snapshot_owner: owner },
        _error: "a different wallet owned this token at the snapshot",
      });
      out.rejected++;
    }
  }
  return out;
}
