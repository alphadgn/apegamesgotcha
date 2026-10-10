// SIWE (EOA + ERC-1271 contract wallet), historical snapshot indexing/verification and burn verification
// against real contracts on anvil and a real PostgreSQL database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, KEYS, pgDb, startAnvil } from "./anvil";
import { createDb, createUser, rpc } from "../../supabase/tests/db/harness";
import { ADMIN_ACTOR, verifyEconomics } from "../../supabase/tests/db/fixtures";
import {
  buildChallenge,
  verifyChallengeSignature,
  siteFromRequest,
} from "../../src/lib/siwe.server";
import { indexSnapshot, verifyClaims, type Collection } from "../../src/lib/snapshot.server";
import { listOwnedTokens, verifyBurn, type NftConfig } from "../../src/lib/nft.server";

let anvil: Awaited<ReturnType<typeof startAnvil>>;
const nftArt = artifact("TestMocks.sol", "MockNonEnumerableNFT");
const walletArt = artifact("TestMocks.sol", "MockERC1271Wallet");
const player = privateKeyToAccount(KEYS.player);
const other = privateKeyToAccount(KEYS.other);

before(async () => {
  anvil = await startAnvil(33139); // pretend ApeChain
});
after(() => anvil?.stop());

test("SIWE: EOA and ERC-1271 contract wallets verify; replays, wrong domain and wrong chain fail", async () => {
  const db = await createDb({ label: "siwechain" });
  try {
    const u = await createUser(db.sql);
    const site = siteFromRequest(
      new Request("https://gotcha.example/_serverFn/x", {
        headers: { origin: "https://gotcha.example", host: "gotcha.example" },
      }),
    );
    assert.deepEqual(site, { domain: "gotcha.example", uri: "https://gotcha.example/dashboard" });
    assert.throws(
      () =>
        siteFromRequest(
          new Request("https://gotcha.example/x", {
            headers: { origin: "https://evil.example", host: "gotcha.example" },
          }),
        ),
      /must come from this site/,
    );

    const link = async (address: string, sign: (m: string) => Promise<Hex>) => {
      const c = buildChallenge({ address, chainId: 33139, ...site });
      await rpc(db.sql, "issue_wallet_challenge", {
        _user_id: u,
        _address: address.toLowerCase(),
        _chain_id: 33139,
        _domain: site.domain,
        _uri: site.uri,
        _nonce: c.nonce,
        _message: c.message,
        _ttl_seconds: 600,
      });
      const sig = await sign(c.message);
      const stored = {
        message: c.message,
        address: address.toLowerCase(),
        chain_id: 33139,
        domain: site.domain,
        nonce: c.nonce,
      };
      await verifyChallengeSignature(anvil.pub, stored, sig);
      await rpc(db.sql, "link_wallet_with_challenge", {
        _user_id: u,
        _nonce: c.nonce,
        _address: address,
        _domain: site.domain,
        _chain_id: 33139,
      });
      return { stored, sig, nonce: c.nonce };
    };
    // Ordinary account.
    const eoa = await link(player.address, (m) => player.signMessage({ message: m }));
    await assert.rejects(
      rpc(db.sql, "link_wallet_with_challenge", {
        _user_id: u,
        _nonce: eoa.nonce,
        _address: player.address,
        _domain: site.domain,
        _chain_id: 33139,
      }),
      /already used/,
    );
    // Smart-contract wallet owned by `other` (ERC-1271).
    const scw = await anvil.deploy(walletArt, [other.address]);
    await link(scw, (m) => other.signMessage({ message: m }));
    const wallets = await db.sql<
      { address: string }[]
    >`select address from public.wallets where user_id = ${u} order by address`;
    assert.deepEqual(
      wallets.map((w) => w.address).sort(),
      [player.address.toLowerCase(), scw.toLowerCase()].sort(),
    );

    // Wrong signer, wrong chain.
    const c = buildChallenge({ address: player.address, chainId: 33139, ...site });
    const stored = {
      message: c.message,
      address: player.address.toLowerCase(),
      chain_id: 33139,
      domain: site.domain,
      nonce: c.nonce,
    };
    await assert.rejects(
      verifyChallengeSignature(anvil.pub, stored, await other.signMessage({ message: c.message })),
      /does not match/,
    );
    await assert.rejects(
      verifyChallengeSignature(
        anvil.pub,
        { ...stored, chain_id: 1 },
        await player.signMessage({ message: c.message }),
      ),
      /doesn't match|wrong chain/,
    );
    const expired = buildChallenge({
      address: player.address,
      chainId: 33139,
      ...site,
      now: new Date(Date.now() - 3600_000),
    });
    await assert.rejects(
      verifyChallengeSignature(
        anvil.pub,
        { ...stored, message: expired.message, nonce: expired.nonce },
        await player.signMessage({ message: expired.message }),
      ),
      /expired/,
    );
  } finally {
    await db.drop();
  }
});

test("snapshot: non-enumerable collection, >200 tokens, later buyer excluded, outages and wrong chain stay pending", async () => {
  const db = await createDb({ label: "snapchain" });
  const sql = db.sql;
  try {
    const nft = await anvil.deploy(nftArt);
    const holder = anvil.wallet(KEYS.player);
    const mintTo = async (to: Hex, from: number, n: number) =>
      anvil.pub.waitForTransactionReceipt({
        hash: await holder.writeContract({
          address: nft,
          abi: nftArt.abi,
          functionName: "mintBatch",
          args: [to, BigInt(from), BigInt(n)],
          account: holder.account!,
          chain: anvil.chain,
        }),
      });
    const deployBlock = await anvil.pub.getBlockNumber();
    await mintTo(player.address, 1, 150);
    await mintTo(player.address, 151, 100); // 250 tokens, minted in two transactions
    // Before the snapshot: player sells token 1 to `other`.
    await anvil.pub.waitForTransactionReceipt({
      hash: await holder.writeContract({
        address: nft,
        abi: nftArt.abi,
        functionName: "transferFrom",
        args: [player.address, other.address, 1n],
        account: holder.account!,
        chain: anvil.chain,
      }),
    });
    const snapBlock = await anvil.pub.getBlock();
    // After the snapshot: player sells token 2 to a later buyer.
    const laterBuyer = privateKeyToAccount(
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    );
    await anvil.pub.waitForTransactionReceipt({
      hash: await holder.writeContract({
        address: nft,
        abi: nftArt.abi,
        functionName: "transferFrom",
        args: [player.address, laterBuyer.address, 2n],
        account: holder.account!,
        chain: anvil.chain,
      }),
    });

    // Live listing reports non-enumerable instead of guessing (and no 200 cap applies to enumerable ones).
    const live = await listOwnedTokens(
      { contract: nft, chain_id: 33139, rpc_url: anvil.url } as NftConfig,
      player.address,
      { client: anvil.pub },
    );
    assert.deepEqual([live.enumerable, live.balance], [false, 248]);

    const [col] = await sql<
      { id: string }[]
    >`insert into public.nft_collections (chain_id, contract, edition, name, snapshot_block, snapshot_block_hash, index_from_block)
      values (33139, ${nft.toLowerCase()}, 'test-2025', 'Test', ${Number(snapBlock.number)}, ${snapBlock.hash!.toLowerCase()}, ${Number(deployBlock)}) returning id`;
    const load = async () =>
      (await sql<Collection[]>`select * from public.nft_collections where id = ${col!.id}`)[0]!;
    const pdb = pgDb(sql);
    // Wrong chain RPC is refused before indexing.
    const wrongChain = { ...anvil.pub, getChainId: async () => 1 } as unknown as PublicClient;
    await assert.rejects(indexSnapshot(pdb, wrongChain, await load(), { rangeSize: 2 }), /chain 1/);
    // Index in small, resumable ranges.
    let r = await indexSnapshot(pdb, anvil.pub, await load(), { rangeSize: 1, maxRanges: 2 });
    assert.equal(r.done, false);
    r = await indexSnapshot(pdb, anvil.pub, await load(), { rangeSize: 1, maxRanges: 100 });
    assert.equal(r.done, true);
    const owners = await sql<
      { n: string }[]
    >`select count(*)::text n from public.nft_snapshot_owners where collection_id = ${col!.id} and owner_address = ${player.address.toLowerCase()}`;
    assert.equal(
      owners[0]!.n,
      "249",
      "token 1 sold before the snapshot; token 2 still the player's at the snapshot",
    );
    await rpc(sql, "verify_nft_collection", {
      _collection_id: col!.id,
      _evidence: "test collection confirmed",
      _actor: ADMIN_ACTOR,
    });

    const now = Date.now();
    const [s] = await rpc<{ id: string }>(sql, "create_season_draft", {
      _slug: "snap-chain",
      _name: "Snap",
      _starts_at: new Date(now - 3600e3),
      _ends_at: new Date(now + 86400e3),
      _settlement_deadline: new Date(now + 2 * 86400e3),
      _rules: {},
      _notes: null,
      _actor: ADMIN_ACTOR,
    });
    await rpc(sql, "set_season_collections", {
      _season_id: s!.id,
      _collection_ids: [col!.id],
      _actor: ADMIN_ACTOR,
    });
    await rpc(sql, "activate_season", { _season_id: s!.id, _actor: ADMIN_ACTOR });

    const p = await createUser(sql);
    const buyer = await createUser(sql);
    await rpc(sql, "link_privy_wallet", {
      _user_id: p,
      _address: player.address,
      _kind: "external",
    });
    await rpc(sql, "link_privy_wallet", {
      _user_id: buyer,
      _address: laterBuyer.address,
      _kind: "external",
    });
    assert.equal(
      (await rpc(sql, "request_snapshot_claims", { _user_id: buyer, _season_id: s!.id })).length,
      0,
      "later buyer gets nothing",
    );
    const claims = await rpc<{
      id: string;
      collection_id: string;
      token_id: string;
      owner_address: string;
    }>(sql, "request_snapshot_claims", { _user_id: p, _season_id: s!.id });
    assert.equal(claims.length, 249);

    const frozen = await load();
    // Archive RPC down → unavailable, nothing awarded, never latest ownership.
    const down = anvil.interceptedClient(async (m, _p, fwd) =>
      m === "eth_call" ? Promise.reject(new Error("header not found")) : fwd(),
    );
    const o1 = await verifyClaims(pdb, down, frozen, claims.slice(0, 5));
    assert.deepEqual(o1, { verified: 0, rejected: 0, unavailable: 5 });
    const o2 = await verifyClaims(pdb, null, frozen, claims.slice(5, 6));
    assert.equal(o2.unavailable, 1);
    // Archive RPC healthy: ownerOf AT the snapshot block — token 2 counts even though it was sold afterwards.
    const o3 = await verifyClaims(pdb, anvil.pub, frozen, claims);
    assert.equal(o3.verified, 249);
    const t2 = await sql<
      { status: string }[]
    >`select status from public.nft_snapshot_claims where token_id = 2 and user_id = ${p}`;
    assert.equal(t2[0]!.status, "verified");
    const [{ nft_points }] = await sql<
      { nft_points: string }[]
    >`select nft_points::text from public.season_scores where season_id = ${s!.id} and user_id = ${p}`;
    assert.equal(nft_points, String(249 * 100));
  } finally {
    await db.drop();
  }
});

test("burns: finality depth, canonical block, linked wallet, multiple NFTs in one transaction", async () => {
  const db = await createDb({ label: "burnchain" });
  const sql = db.sql;
  try {
    const nft = await anvil.deploy(nftArt);
    const w = anvil.wallet(KEYS.player);
    await anvil.pub.waitForTransactionReceipt({
      hash: await w.writeContract({
        address: nft,
        abi: nftArt.abi,
        functionName: "mintBatch",
        args: [player.address, 500n, 3n],
        account: w.account!,
        chain: anvil.chain,
      }),
    });
    const dead = "0x000000000000000000000000000000000000dEaD" as Hex;
    const tx = await w.writeContract({
      address: nft,
      abi: nftArt.abi,
      functionName: "transferMany",
      args: [dead, [500n, 501n]],
      account: w.account!,
      chain: anvil.chain,
    });
    await anvil.pub.waitForTransactionReceipt({ hash: tx });
    const cfg: NftConfig = {
      contract: nft,
      chain_id: 33139,
      rpc_url: anvil.url,
      level_trait: "Level",
      burn_min_level: 4,
      burn_address: dead,
      burn_min_confirmations: 5,
    };
    await assert.rejects(verifyBurn(cfg, tx, 500n, [player.address], anvil.pub), /confirming/);
    await anvil.mine(5);
    await assert.rejects(verifyBurn(cfg, tx, 500n, [other.address], anvil.pub), /linked wallet/);
    await assert.rejects(
      verifyBurn({ ...cfg, chain_id: 1 }, tx, 500n, [player.address], anvil.pub),
      /wrong chain/,
    );
    const e1 = await verifyBurn(cfg, tx, 500n, [player.address], anvil.pub);
    const e2 = await verifyBurn(cfg, tx, 501n, [player.address], anvil.pub);
    assert.notEqual(e1.logIndex, e2.logIndex);

    await verifyEconomics(sql);
    await sql`insert into public.sponsored_budgets (source, name, funded_usd, evidence) values ('burn', 'Burn rewards', 5000, 'allocation memo')`;
    await sql`update public.app_config set value = value || ${sql.json({ chain_id: 33139, contract: nft.toLowerCase(), burn_min_confirmations: 5 } as never)} where key = 'nft'`;
    const u = await createUser(sql);
    await rpc(sql, "link_privy_wallet", {
      _user_id: u,
      _address: player.address,
      _kind: "external",
    });
    for (const e of [e1, e2]) {
      await rpc(sql, "record_burn_claim", {
        _user_id: u,
        _chain_id: e.chainId,
        _contract: e.contract,
        _token_id: e.tokenId,
        _tx_hash: e.txHash,
        _log_index: e.logIndex,
        _from: e.from,
        _to: e.to,
        _level: 5,
        _level_source: "admin_override",
        _block_number: Number(e.blockNumber),
        _block_hash: e.blockHash,
        _confirmations: e.confirmations,
        _evidence: {},
      });
    }
    const credits =
      await sql`select 1 from public.spin_credits where user_id = ${u} and source = 'burn'`;
    assert.equal(credits.length, 2, "two NFTs burned in one transaction → two credits");
    await assert.rejects(
      rpc(sql, "record_burn_claim", {
        _user_id: u,
        _chain_id: e1.chainId,
        _contract: e1.contract,
        _token_id: e1.tokenId,
        _tx_hash: e1.txHash,
        _log_index: e1.logIndex,
        _from: e1.from,
        _to: e1.to,
        _level: 5,
        _level_source: "admin_override",
        _block_number: Number(e1.blockNumber),
        _block_hash: e1.blockHash,
        _confirmations: e1.confirmations,
        _evidence: {},
      }),
      /already claimed/,
    );
  } finally {
    await db.drop();
  }
});
