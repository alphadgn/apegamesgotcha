import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, createDb, createUser, hash32, rejects, rpc, type Sql } from "./harness";
import { ADMIN_ACTOR, verifyEconomics } from "./fixtures";

const SNAP_BLOCK = 100;
const SNAP_HASH = hash32(0x5a5a);

async function linkWallet(sql: Sql, u: string, a: string) {
  await rpc(sql, "link_privy_wallet", { _user_id: u, _address: a, _kind: "external" });
}

test("historical snapshot: later buyers get nothing, >200 tokens and multiple wallets work, outages stay pending, one award per token ever", async () => {
  const db = await createDb({ label: "nft" });
  const sql = db.sql;
  try {
    const [col] = await sql<
      { id: string }[]
    >`select id from public.nft_collections where status = 'candidate'`;
    const cid = col!.id;
    const [X1, X2, Y, Z] = [addr(0x1001), addr(0x1002), addr(0x2001), addr(0x3001)];

    await rejects(
      rpc(sql, "apply_snapshot_transfers", {
        _collection_id: cid,
        _from_block: 0,
        _to_block: 10,
        _rows: [],
        _complete: false,
      }),
      /snapshot block and hash first/,
    );
    await sql`update public.nft_collections set snapshot_block = ${SNAP_BLOCK}, snapshot_block_hash = ${SNAP_HASH}, index_from_block = 0 where id = ${cid}`;

    // Mint 1..250: 1..200 to X1, 201..250 to X2 (block 10); token 1 sold to Y at block 50 (before the snapshot).
    const mints = Array.from({ length: 250 }, (_, i) => ({
      token_id: String(i + 1),
      to: i < 200 ? X1 : X2,
      block: 10,
      log_index: i,
    }));
    await rpc(sql, "apply_snapshot_transfers", {
      _collection_id: cid,
      _from_block: 0,
      _to_block: 40,
      _rows: mints,
      _complete: false,
    });
    await rejects(
      rpc(sql, "apply_snapshot_transfers", {
        _collection_id: cid,
        _from_block: 60,
        _to_block: 70,
        _rows: [],
        _complete: false,
      }),
      /contiguous/,
    );
    await rejects(
      rpc(sql, "apply_snapshot_transfers", {
        _collection_id: cid,
        _from_block: 41,
        _to_block: 150,
        _rows: [],
        _complete: false,
      }),
      /at or before the snapshot/,
    );
    await rejects(
      rpc(sql, "verify_nft_collection", {
        _collection_id: cid,
        _evidence: "contract confirmed by team",
        _actor: ADMIN_ACTOR,
      }),
      /Finish indexing/,
    );
    await rpc(sql, "apply_snapshot_transfers", {
      _collection_id: cid,
      _from_block: 41,
      _to_block: SNAP_BLOCK,
      _rows: [{ token_id: "1", to: Y, block: 50, log_index: 0 }],
      _complete: true,
    });
    await rpc(sql, "verify_nft_collection", {
      _collection_id: cid,
      _evidence: "contract + block hash confirmed by team on apescan",
      _actor: ADMIN_ACTOR,
    });
    await rejects(
      sql`update public.nft_collections set snapshot_block = 101 where id = ${cid}`,
      /immutable/,
    );

    const now = Date.now();
    const [s] = await rpc<{ id: string }>(sql, "create_season_draft", {
      _slug: "nft-season",
      _name: "NFT",
      _starts_at: new Date(now - 3600e3),
      _ends_at: new Date(now + 86400e3),
      _settlement_deadline: new Date(now + 2 * 86400e3),
      _rules: {},
      _notes: null,
      _actor: ADMIN_ACTOR,
    });
    await rpc(sql, "set_season_collections", {
      _season_id: s!.id,
      _collection_ids: [cid],
      _actor: ADMIN_ACTOR,
    });
    await rpc(sql, "activate_season", { _season_id: s!.id, _actor: ADMIN_ACTOR });
    const [frozen] = await sql<
      { status: string }[]
    >`select status from public.nft_collections where id = ${cid}`;
    assert.equal(frozen!.status, "frozen");
    await rejects(sql`delete from public.season_collections where season_id = ${s!.id}`, /frozen/);

    const holder = await createUser(sql);
    const seller = await createUser(sql);
    const laterBuyer = await createUser(sql);
    await linkWallet(sql, holder, X1);
    await linkWallet(sql, holder, X2);
    await linkWallet(sql, seller, Y);
    await linkWallet(sql, laterBuyer, Z); // Z bought token 2 after the snapshot (not in the snapshot owners)

    const both = await Promise.all(
      [1, 2].map(() =>
        rpc<{ id: string; token_id: string }>(sql, "request_snapshot_claims", {
          _user_id: holder,
          _season_id: s!.id,
        }),
      ),
    );
    assert.equal(
      both[0].length + both[1].length,
      249,
      "tokens 2..250 across two wallets, no duplicates under concurrency",
    );
    assert.equal(
      (await rpc(sql, "request_snapshot_claims", { _user_id: laterBuyer, _season_id: s!.id }))
        .length,
      0,
      "current owners never inherit snapshot recognition",
    );
    const [yc] = await rpc<{ id: string; token_id: string }>(sql, "request_snapshot_claims", {
      _user_id: seller,
      _season_id: s!.id,
    });
    assert.equal(yc!.token_id, "1");

    const claims = await sql<
      { id: string; token_id: string; owner_address: string }[]
    >`select id, token_id::text, owner_address from public.nft_snapshot_claims where user_id = ${holder} order by token_id`;
    const ev = { chain_id: 33139, block_number: SNAP_BLOCK, block_hash: SNAP_HASH };
    // Archive RPC outage → unavailable (retry later), never latest ownership.
    const [out] = await rpc<{ status: string; attempts: number }>(sql, "resolve_snapshot_claim", {
      _claim_id: claims[0]!.id,
      _outcome: "unavailable",
      _snapshot_owner: null,
      _evidence: {},
      _error: "archive node timeout",
    });
    assert.deepEqual([out!.status, out!.attempts], ["unavailable", 1]);
    await rejects(
      rpc(sql, "resolve_snapshot_claim", {
        _claim_id: claims[0]!.id,
        _outcome: "verified",
        _snapshot_owner: claims[0]!.owner_address,
        _evidence: { ...ev, chain_id: 1 },
        _error: null,
      }),
      /snapshot block on the configured chain/,
    );
    await rejects(
      rpc(sql, "resolve_snapshot_claim", {
        _claim_id: claims[0]!.id,
        _outcome: "verified",
        _snapshot_owner: claims[0]!.owner_address,
        _evidence: { ...ev, block_hash: hash32(1) },
        _error: null,
      }),
      /snapshot block on the configured chain/,
    );
    await rejects(
      rpc(sql, "resolve_snapshot_claim", {
        _claim_id: claims[0]!.id,
        _outcome: "verified",
        _snapshot_owner: Z,
        _evidence: ev,
        _error: null,
      }),
      /does not match/,
    );
    for (const c of claims) {
      await rpc(sql, "resolve_snapshot_claim", {
        _claim_id: c.id,
        _outcome: "verified",
        _snapshot_owner: c.owner_address,
        _evidence: ev,
        _error: null,
      });
    }
    await rpc(sql, "resolve_snapshot_claim", {
      _claim_id: claims[0]!.id,
      _outcome: "verified",
      _snapshot_owner: claims[0]!.owner_address,
      _evidence: ev,
      _error: null,
    });
    const [score] = await sql<
      { nft: string }[]
    >`select nft_points::text nft from public.season_scores where season_id = ${s!.id} and user_id = ${holder}`;
    assert.equal(score!.nft, String(249 * 100), "scored once per token");
    // Re-requesting never creates a second claim for a recognised token.
    assert.equal(
      (await rpc(sql, "request_snapshot_claims", { _user_id: holder, _season_id: s!.id })).length,
      0,
    );
    // A rejected claim frees the token only for a legitimate owner.
    await rpc(sql, "resolve_snapshot_claim", {
      _claim_id: yc!.id,
      _outcome: "rejected",
      _snapshot_owner: X1,
      _evidence: ev,
      _error: "owner differs",
    });
    const [st] = await sql<
      { status: string }[]
    >`select status from public.nft_snapshot_claims where id = ${yc!.id}`;
    assert.equal(st!.status, "rejected");
  } finally {
    await db.drop();
  }
});

test("burns: verified source wallet, finality, level, funded credit, atomic, multiple NFTs per tx", async () => {
  const db = await createDb({ label: "burns" });
  const sql = db.sql;
  try {
    const u = await createUser(sql);
    const other = await createUser(sql);
    const W = addr(0x4001);
    await linkWallet(sql, u, W);
    const contract = "0x8bb7b20291a9fa2f25705b8487194b410808c28b";
    const burn = (args: Partial<Record<string, unknown>> = {}) =>
      rpc(sql, "record_burn_claim", {
        _user_id: u,
        _chain_id: 33139,
        _contract: contract,
        _token_id: "77",
        _tx_hash: hash32(0xb1),
        _log_index: 3,
        _from: W,
        _to: "0x000000000000000000000000000000000000dEaD",
        _level: 5,
        _level_source: "pre_burn_metadata",
        _block_number: 500,
        _block_hash: hash32(0xb10c),
        _confirmations: 20,
        _evidence: {},
        ...args,
      });
    await rejects(burn({ _user_id: other }), /linked wallets/);
    await rejects(burn({ _chain_id: 1 }), /Wrong chain/);
    await rejects(burn({ _contract: addr(5) }), /Not the ApeGames/);
    await rejects(burn({ _to: addr(9) }), /burn address/);
    await rejects(burn({ _confirmations: 2 }), /not final/);
    await rejects(burn({ _level: 3 }), /Level 4\+/);
    await rejects(burn({ _level_source: "user_supplied" }), /Untrusted level/);
    // No funded burn budget → the whole claim rolls back.
    await rejects(burn(), /paused/);
    assert.equal((await sql`select 1 from public.burn_claims`).length, 0);

    await verifyEconomics(sql);
    await sql`insert into public.sponsored_budgets (source, name, funded_usd, evidence) values ('burn', 'Burn rewards', 5000, 'treasury allocation memo')`;
    await burn();
    const [h] = await sql<
      { burned: boolean }[]
    >`select burned from public.nft_holdings where token_id = '77'`;
    assert.equal(h!.burned, true);
    const [c] = await sql<
      { n: string }[]
    >`select count(*)::text n from public.spin_credits c join public.sponsored_reservations r on r.credit_id = c.id where c.user_id = ${u} and c.source = 'burn'`;
    assert.equal(c!.n, "1");
    await rejects(burn(), /already claimed/);
    await rejects(burn({ _token_id: "78" }), /already claimed/); // same tx + log index
    await burn({ _token_id: "78", _log_index: 4 }); // second NFT in the same transaction
    const credits =
      await sql`select 1 from public.spin_credits where user_id = ${u} and source = 'burn'`;
    assert.equal(credits.length, 2);
  } finally {
    await db.drop();
  }
});
