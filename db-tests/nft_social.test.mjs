// Wallet challenges, historical NFT snapshot claims, burns, and verified X shares.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, rejects } from "./lib.mjs";
import { cleanPool, makeAdmin, activeSeason, giveCredits, confirmedBatch, hex } from "./fixtures.mjs";

let db, admin, season, collection;
const SNAP_HASH = "0x" + "5".repeat(64);
const wallet = (n) => "0x" + n.toString(16).padStart(40, "0");

before(async () => {
  db = await freshDb("nft");
  await cleanPool(db);
  admin = await makeAdmin(db);
  // A ready 2025 collection with an indexed snapshot (the seeded candidate stays a candidate).
  collection = (await db.one(
    `insert into nft_collections(label, edition, chain_id, contract, deploy_block, snapshot_block, snapshot_block_hash)
     values ('Test 2025', '2025', 33139, $1, 100, 5000, $2) returning id`,
    ["0x" + "e".repeat(40), SNAP_HASH],
  )).id;
  // Index snapshot owners (as the indexer would from Transfer logs), including >200 tokens for one owner.
  const owner = wallet(0xa1);
  const values = [];
  for (let t = 1; t <= 250; t++) values.push(`('${collection}', ${t}, '${owner}', 4000)`);
  values.push(`('${collection}', 9999, '${wallet(0xb2)}', 4100)`);
  await db.q(`insert into nft_snapshot_owners(collection_id, token_id, owner, last_transfer_block) values ${values.join(",")}`);
  await db.q(`update nft_collections set indexed_through_block = 5000, status = 'ready', verified_by = $2, verified_at = now() where id = $1`, [collection, admin]);
  const rules = (await db.one(`select default_season_rules() r`)).r;
  season = await activeSeason(db, admin, { rules, collectionIds: [collection] });
});
after(async () => db?.close());

const link = (u, addr) => db.rpc("link_verified_wallet", [u, addr, "external", "siwe", 33139, false]);
const total = async (u) => (await db.one(`select total_points from season_scores where season_id = $1 and user_id = $2`, [season, u]))?.total_points ?? "0";

// ---------------------------------------------------------------- wallets
test("SIWE challenge: consume-once, expiry, wrong user, concurrent consumption", async () => {
  const u = await db.createUser();
  const nonce = "abcdef0123456789abcd";
  await db.q(`insert into wallet_challenges(nonce, user_id, address, chain_id, domain, uri, message, expires_at)
              values ($1, $2, $3, 1, 'gotcha.example', 'https://gotcha.example', 'msg', now() + interval '10 minutes')`, [nonce, u, wallet(0x11)]);
  await rejects(db.rpc("consume_wallet_challenge", [nonce, await db.createUser()]), /invalid, expired or already used/);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => db.rpc("consume_wallet_challenge", [nonce, u])));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const expired = "expired0123456789abc";
  await db.q(`insert into wallet_challenges(nonce, user_id, address, chain_id, domain, uri, message, issued_at, expires_at)
              values ($1, $2, $3, 1, 'd', 'u', 'm', now() - interval '20 minutes', now() - interval '10 minutes')`, [expired, u, wallet(0x12)]);
  await rejects(db.rpc("consume_wallet_challenge", [expired, u]), /expired/);
  // Challenges cannot live longer than 30 minutes.
  await rejects(db.q(`insert into wallet_challenges(nonce, user_id, address, chain_id, domain, uri, message, expires_at)
              values ('longlived0123456789', $1, $2, 1, 'd', 'u', 'm', now() + interval '2 hours')`, [u, wallet(0x13)]), /check/);
});

test("wallets: multiple per player, never moved between accounts, first becomes default", async () => {
  const [a, b] = [await db.createUser(), await db.createUser()];
  await link(a, wallet(0x21));
  await link(a, wallet(0x22));
  await rejects(link(b, wallet(0x21)), /another account/);
  const rows = await db.q(`select address, is_default from wallets where user_id = $1 order by verified_at, address`, [a]);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.is_default).length, 1);
  // Contract wallets are flagged.
  await db.rpc("link_verified_wallet", [b, wallet(0x23), "external", "erc1271", 33139, true]);
  assert.equal((await db.one(`select is_contract from wallets where address = $1`, [wallet(0x23)])).is_contract, true);
});

// ---------------------------------------------------------------- snapshot claims
test("snapshot owner is rewarded; a later buyer of the same token is not", async () => {
  const [owner, buyer] = [await db.createUser(), await db.createUser()];
  await link(owner, wallet(0xb2));
  await link(buyer, wallet(0xc3)); // bought token 9999 after the snapshot
  // Buyer claims first: the archive check says the snapshot owner was 0xb2, not the buyer.
  await db.rpc("submit_snapshot_claims", [buyer, collection, JSON.stringify([{ token_id: "9999", wallet: wallet(0xc3) }])]);
  const buyerClaim = await db.one(`select id from nft_snapshot_claims where user_id = $1`, [buyer]);
  const [r1] = await db.rpc("record_snapshot_verification", [buyerClaim.id, wallet(0xb2), SNAP_HASH, false, null]);
  assert.equal(r1.status, "rejected");
  assert.equal(await total(buyer), "0");
  // The true snapshot owner can now claim it (a rejected claim does not block the token).
  await db.rpc("submit_snapshot_claims", [owner, collection, JSON.stringify([{ token_id: "9999", wallet: wallet(0xb2) }])]);
  const ownerClaim = await db.one(`select id from nft_snapshot_claims where user_id = $1`, [owner]);
  const [r2] = await db.rpc("record_snapshot_verification", [ownerClaim.id, wallet(0xb2), SNAP_HASH, false, null]);
  assert.equal(r2.status, "verified");
  assert.equal(await total(owner), "100");
});

test("global one-time recognition: same token cannot be claimed twice across users/wallets", async () => {
  const [a, b] = [await db.createUser(), await db.createUser()];
  await link(a, wallet(0xa1));
  await link(b, wallet(0xd4));
  const r = await db.rpc("submit_snapshot_claims", [a, collection, JSON.stringify([{ token_id: "1", wallet: wallet(0xa1) }, { token_id: "1", wallet: wallet(0xa1) }])]);
  assert.deepEqual(r[0].submit_snapshot_claims, { created: 1, already_claimed: 1 });
  const r2 = await db.rpc("submit_snapshot_claims", [b, collection, JSON.stringify([{ token_id: "1", wallet: wallet(0xd4) }])]);
  assert.deepEqual(r2[0].submit_snapshot_claims, { created: 0, already_claimed: 1 });
  // Only wallets verified for the claimant can be used.
  await rejects(db.rpc("submit_snapshot_claims", [b, collection, JSON.stringify([{ token_id: "2", wallet: wallet(0xa1) }])]), /not verified/);
});

test("more than 200 holdings and multiple wallets", async () => {
  const u = await db.createUser();
  // wallet 0xa1 is already linked to another player above; use a dedicated snapshot owner setup
  const big = (await db.one(
    `insert into nft_collections(label, edition, chain_id, contract, deploy_block, snapshot_block, snapshot_block_hash)
     values ('Big 2025', '2025', 33139, $1, 1, 10, $2) returning id`, ["0x" + "f".repeat(40), SNAP_HASH])).id;
  const toks = Array.from({ length: 230 }, (_, i) => ({ token_id: String(i + 1), wallet: i % 2 ? wallet(0xe1) : wallet(0xe2) }));
  await link(u, wallet(0xe1));
  await link(u, wallet(0xe2));
  // Not part of the season snapshot: refused.
  await rejects(db.rpc("submit_snapshot_claims", [u, big, JSON.stringify(toks)]), /not part of the season/);
  // Use the season collection instead: >200 tokens for one player across two wallets.
  const many = Array.from({ length: 230 }, (_, i) => ({ token_id: String(1000 + i), wallet: i % 2 ? wallet(0xe1) : wallet(0xe2) }));
  const [{ submit_snapshot_claims: out }] = await db.rpc("submit_snapshot_claims", [u, collection, JSON.stringify(many)]);
  assert.equal(out.created, 230);
  const claims = await db.q(`select id, wallet_address from nft_snapshot_claims where user_id = $1`, [u]);
  for (const c of claims) await db.rpc("record_snapshot_verification", [c.id, c.wallet_address, SNAP_HASH, false, null]);
  assert.equal(await total(u), String(230 * 100));
});

test("archive outage / wrong chain leaves the claim open and never falls back to latest ownership", async () => {
  const u = await db.createUser();
  await link(u, wallet(0xf5));
  await db.rpc("submit_snapshot_claims", [u, collection, JSON.stringify([{ token_id: "77", wallet: wallet(0xf5) }])]);
  const c = await db.one(`select id from nft_snapshot_claims where user_id = $1`, [u]);
  const [a] = await db.rpc("record_snapshot_verification", [c.id, null, null, true, "archive RPC timeout"]);
  assert.equal(a.status, "unavailable");
  const [b] = await db.rpc("record_snapshot_verification", [c.id, wallet(0xf5), "0x" + "9".repeat(64), false, null]);
  assert.equal(b.status, "unavailable");
  assert.match(b.last_error, /hash mismatch/);
  assert.equal(await total(u), "0");
  // Still blocks finalization until resolved.
  const [{ season_unresolved: open }] = await db.rpc("season_unresolved", [season]);
  assert.ok(open.open_snapshot_claims >= 1);
  await db.rpc("record_snapshot_verification", [c.id, wallet(0x99), SNAP_HASH, false, null]); // resolves as rejected
});

test("a ready collection's snapshot is frozen while a live season uses it", async () => {
  await rejects(db.q(`update nft_collections set snapshot_block = 6000 where id = $1`, [collection]), /frozen/);
  await rejects(db.q(`insert into nft_snapshot_owners(collection_id, token_id, owner, last_transfer_block) values ($1, 424242, $2, 1)`, [collection, wallet(1)]), /frozen/);
});

// ---------------------------------------------------------------- burns
test("burn claims: sponsored budget required; atomic claim+credit+holding; multiple NFTs in one tx", async () => {
  const u = await db.createUser();
  await link(u, wallet(0x77));
  const tx = hex();
  const burn = (token, logIndex) =>
    db.rpc("record_burn_claim", [u, 33139, "0x8bb7b20291a9fa2f25705b8487194b410808c28b", token, tx, logIndex, 10, hex(), wallet(0x77), 5, "tokenURI@pre-burn", {}]);
  // Budget paused by default -> nothing is recorded.
  await rejects(burn("501", 0), /paused/);
  assert.equal((await db.one(`select count(*)::int n from burn_claims where user_id = $1`, [u])).n, 0);
  // Fund it: costs verified via cleanPool + set operating costs.
  await db.q(`update operating_costs set amount_usd = 0.05, verified = true`);
  await db.q(`insert into funding_events(account, amount_usd, evidence, created_by) values ('sponsored_burn', 1000, 'test deposit', $1)`, [admin]);
  await db.q(`update sponsored_budgets set paused = false, pause_reason = null where source = 'burn'`);
  const [{ record_burn_claim: one }] = await burn("501", 0);
  const [{ record_burn_claim: two }] = await burn("502", 1); // same tx, next log
  assert.ok(one.credit_id && two.credit_id);
  await rejects(burn("501", 2), /already claimed/); // same token again
  await rejects(burn("503", 1), /already claimed/); // same tx/log again
  const h = await db.one(`select burned from nft_holdings where token_id = '502'`);
  assert.equal(h.burned, true);
  const credit = await db.one(`select funding, reserved_usd from spin_credits where id = $1`, [one.credit_id]);
  assert.equal(credit.funding, "sponsored");
  assert.ok(Number(credit.reserved_usd) > 0);
  // Level below minimum and unlinked burner are refused.
  await rejects(db.rpc("record_burn_claim", [u, 33139, "0x8bb7b20291a9fa2f25705b8487194b410808c28b", "600", hex(), 0, 1, hex(), wallet(0x77), 2, "x", {}]), /Level/);
  await rejects(db.rpc("record_burn_claim", [u, 33139, "0x8bb7b20291a9fa2f25705b8487194b410808c28b", "601", hex(), 0, 1, hex(), wallet(0x78), 5, "x", {}]), /not verified/);
});

// ---------------------------------------------------------------- X shares
test("X post URLs normalize to post ids (x.com and twitter.com only)", async () => {
  const norm = async (u) => (await db.one(`select normalize_x_post_url($1) v`, [u])).v;
  assert.equal(await norm("https://x.com/goApeGames/status/1844000000000000001"), "1844000000000000001");
  assert.equal(await norm("https://twitter.com/someone/status/123?s=20"), "123");
  assert.equal(await norm("https://mobile.twitter.com/someone/statuses/456/photo/1"), "456");
  assert.equal(await norm("https://evil.com/x.com/a/status/1"), null);
  assert.equal(await norm("http://x.com/a/status/1"), null);
  assert.equal(await norm("javascript:alert(1)"), null);
});

async function playerWithSpin() {
  const u = await db.createUser();
  await giveCredits(db, u, 1);
  const c = await confirmedBatch(db, u, 1);
  await db.rpc("settle_drawn_spin", [c.spinIds[0], 0, "1", c.requestId, 200, hex()]);
  return { u, spin: c.spinIds[0] };
}

test("share rewards: verified only, one per spin, one per UTC day, slots never reopen", async () => {
  const { u, spin } = await playerWithSpin();
  const base = await total(u);
  await rejects(db.rpc("submit_social_share", [u, "https://x.com/a/status/1", spin, "manual"]), /Link your X account/);
  await db.rpc("link_x_account", [u, "ape_one", null, "manual"]);
  await rejects(db.rpc("submit_social_share", [u, "https://x.com/a/status/2", spin, "none"]), /not configured/);
  const [s1] = await db.rpc("submit_social_share", [u, "https://x.com/ape_one/status/1001", spin, "manual"]);
  assert.equal(s1.status, "pending");
  assert.equal(await total(u), base); // nothing for a mere submission
  await rejects(db.rpc("submit_social_share", [u, "https://twitter.com/ape_one/status/1001", spin, "manual"]), /already submitted/);

  // Only admins review manually.
  await rejects(db.rpc("review_social_share", [s1.id, true, "manual", u, null, "ape_one", new Date(), true, {}, null]), /Forbidden/);
  // Wrong author -> rejected.
  const [bad] = await db.rpc("review_social_share", [s1.id, true, "manual", admin, null, "someone_else", new Date(), true, {}, null]);
  assert.equal(bad.status, "rejected");

  const [s2] = await db.rpc("submit_social_share", [u, "https://x.com/ape_one/status/1002", spin, "manual"]);
  const [ok] = await db.rpc("review_social_share", [s2.id, true, "manual", admin, null, "ape_one", new Date(Date.now() - 60_000), true, { note: "checked" }, null]);
  assert.equal(ok.status, "approved");
  assert.equal(BigInt(await total(u)) - BigInt(base), 2n);

  // Same spin again -> refused at submission.
  await rejects(db.rpc("submit_social_share", [u, "https://x.com/ape_one/status/1003", spin, "manual"]), /already earned/);

  // Reversal does not reopen the day or the spin.
  await db.rpc("reverse_ledger_entry", [ok.ledger_id, null, "post deleted", admin]);
  await rejects(db.rpc("submit_social_share", [u, "https://x.com/ape_one/status/1004", spin, "manual"]), /already earned/);
});

test("daily cap on approvals (UTC day) even with two different spins; concurrent approvals award once", async () => {
  const u = await db.createUser();
  await db.rpc("link_x_account", [u, "ape_two", "777", "oauth"]);
  const spins = [];
  for (let i = 0; i < 2; i++) {
    await giveCredits(db, u, 1);
    const c = await confirmedBatch(db, u, 1);
    await db.rpc("settle_drawn_spin", [c.spinIds[0], 0, "1", c.requestId, 200, hex()]);
    spins.push(c.spinIds[0]);
  }
  const [a] = await db.rpc("submit_social_share", [u, "https://x.com/ape_two/status/2001", spins[0], "x_api"]);
  const [b] = await db.rpc("submit_social_share", [u, "https://x.com/ape_two/status/2002", spins[1], "x_api"]);
  const before = BigInt(await total(u));
  const res = await Promise.all([a, b].map((s) => db.rpc("review_social_share", [s.id, true, "x_api", null, "777", "ape_two", new Date(Date.now() - 60_000), true, {}, null])));
  const statuses = res.map((r) => r[0].status).sort();
  assert.deepEqual(statuses, ["approved", "not_rewarded"]);
  assert.equal(BigInt(await total(u)) - before, 2n);
  // award_day is the server's UTC submission date
  const day = await db.one(`select award_day::text d, (now() at time zone 'UTC')::date::text today from social_shares where id = $1`, [a.id]);
  assert.equal(day.d, day.today);
});

test("posts must be made during the season and before submission; author must match the linked id", async () => {
  const { u, spin } = await playerWithSpin();
  await db.rpc("link_x_account", [u, "ape_three", "888", "oauth"]);
  const [s] = await db.rpc("submit_social_share", [u, "https://x.com/ape_three/status/3001", spin, "x_api"]);
  const [future] = await db.rpc("review_social_share", [s.id, true, "x_api", null, "888", "ape_three", new Date(Date.now() + 3600_000), true, {}, null]);
  assert.match(future.decision_reason, /newer than the submission/);
  const [s2] = await db.rpc("submit_social_share", [u, "https://x.com/ape_three/status/3002", spin, "x_api"]);
  const [old] = await db.rpc("review_social_share", [s2.id, true, "x_api", null, "888", "ape_three", new Date("2020-01-01"), true, {}, null]);
  assert.match(old.decision_reason, /during the season/);
  const [s3] = await db.rpc("submit_social_share", [u, "https://x.com/ape_three/status/3003", spin, "x_api"]);
  const [other] = await db.rpc("review_social_share", [s3.id, true, "x_api", null, "999", "ape_three", new Date(Date.now() - 1000), true, {}, null]);
  assert.match(other.decision_reason, /not the linked X account/);
});

test("submission rate limits and one linked X account at a time", async () => {
  const { u, spin } = await playerWithSpin();
  await db.rpc("link_x_account", [u, "ape_four", null, "manual"]);
  for (let i = 0; i < 3; i++) await db.rpc("submit_social_share", [u, `https://x.com/ape_four/status/40${i}`, spin, "manual"]);
  await rejects(db.rpc("submit_social_share", [u, "https://x.com/ape_four/status/409", spin, "manual"]), /3 posts waiting/);
  // Another player can't take the same handle; relinking keeps history.
  const v = await db.createUser();
  await rejects(db.rpc("link_x_account", [v, "Ape_Four", null, "manual"]), /another player/);
  await db.rpc("link_x_account", [u, "ape_four_new", null, "manual"]);
  const hist = await db.q(`select handle, unlinked_at from x_accounts where user_id = $1 order by linked_at`, [u]);
  assert.equal(hist.length, 2);
  assert.ok(hist[0].unlinked_at);
});
