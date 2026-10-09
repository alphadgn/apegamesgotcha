import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, createUser, rejects, rpc, type Sql } from "./harness";
import {
  activeSeason,
  ADMIN_ACTOR,
  buySpins,
  drawConfirmed,
  enableVrf,
  publishPool,
  settle,
  verifyEconomics,
} from "./fixtures";

test("x post links normalise to post ids; anything else is refused (no arbitrary URLs)", async () => {
  const db = await createDb({ label: "xurl" });
  try {
    const n = async (u: string) =>
      (await db.sql<{ v: string | null }[]>`select public.normalize_x_post_url(${u}) as v`)[0]!.v;
    assert.equal(
      await n("https://x.com/goApeGames/status/1845000000000000001"),
      "1845000000000000001",
    );
    assert.equal(
      await n("https://twitter.com/someone/status/1845000000000000002?s=20"),
      "1845000000000000002",
    );
    assert.equal(
      await n("https://mobile.twitter.com/someone/status/1845000000000000003/photo/1"),
      "1845000000000000003",
    );
    assert.equal(await n("https://x.com/i/web/status/1845000000000000004"), "1845000000000000004");
    for (const bad of [
      "http://x.com/a/status/1845000000000000005",
      "https://evil.com/x.com/a/status/1",
      "https://x.com.evil.io/a/status/1845000000000000006",
      "https://x.com/a/status/abc",
      "javascript:alert(1)",
      "https://x.com/goApeGames",
    ]) {
      assert.equal(await n(bad), null, bad);
    }
  } finally {
    await db.drop();
  }
});

test("verified X shares: fraud checks, one post/spin/day, UTC days, concurrency, reversals don't reopen the day", async () => {
  const db = await createDb({ label: "social" });
  const sql = db.sql;
  try {
    await verifyEconomics(sql);
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    const season = await activeSeason(sql, { rules: { social_enabled: true } });
    const [{ i }] = await sql<
      { i: number }[]
    >`select onchain_index as i from public.prizes where name = 'Banana Chip'`;
    const play = async (u: string, n: number) => {
      const d = await drawConfirmed(sql, u, n, version);
      for (const id of d.spinIds) await settle(sql, id, i!, d.requestId);
      return d.spinIds;
    };
    const alice = await createUser(sql);
    const bob = await createUser(sql);
    await buySpins(sql, alice, 10);
    await buySpins(sql, bob, 5);
    const aliceSpins = await play(alice, 4);
    const bobSpins = await play(bob, 1);
    const post = (n: number) =>
      `https://x.com/alice_apes/status/18450000000000000${String(n).padStart(2, "0")}`;
    const submit = (u: string, spin: string, url: string) =>
      rpc<{ id: string; status: string; award_day: string }>(sql, "submit_social_share", {
        _user_id: u,
        _spin_id: spin,
        _post_url: url,
      }).then((r) => r[0]!);
    const goodEvidence = (extra: Record<string, unknown> = {}) => ({
      author_username: "alice_apes",
      post_created_at: new Date(Date.now() - 60_000).toISOString(),
      references_spin: true,
      public: true,
      ...extra,
    });
    const review = (
      id: string,
      decision: "approve" | "reject",
      evidence: Record<string, unknown>,
      reason: string | null = null,
    ) =>
      rpc<{ status: string }>(sql, "review_social_share", {
        _share_id: id,
        _decision: decision,
        _verifier: "manual_review",
        _evidence: evidence,
        _reason: reason,
        _actor: ADMIN_ACTOR,
      }).then((r) => r[0]!);

    await rejects(submit(alice, aliceSpins[0]!, post(1)), /Link your X account/);
    await rpc(sql, "link_x_account", {
      _user_id: alice,
      _username: "@alice_apes",
      _x_user_id: null,
      _verification: "self_declared",
      _evidence: {},
    });
    await rejects(
      rpc(sql, "link_x_account", {
        _user_id: bob,
        _username: "Alice_Apes",
        _x_user_id: null,
        _verification: "self_declared",
        _evidence: {},
      }),
      /another player/,
    );
    await rpc(sql, "link_x_account", {
      _user_id: bob,
      _username: "bob_apes",
      _x_user_id: null,
      _verification: "self_declared",
      _evidence: {},
    });

    await rejects(submit(alice, bobSpins[0]!, post(1)), /isn't yours/);
    await rejects(submit(alice, aliceSpins[0]!, "https://example.com/post/1"), /Paste the link/);
    const s1 = await submit(alice, aliceSpins[0]!, post(1));
    assert.equal(s1.status, "pending", "a submission alone earns nothing");
    assert.equal(
      new Date(s1.award_day).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
      "award day from the server UTC date",
    );
    const [{ total: before }] = await sql<
      { total: string }[]
    >`select total::text from public.season_scores where season_id = ${season.id} and user_id = ${alice}`;
    await rejects(submit(bob, bobSpins[0]!, post(1)), /already submitted/);
    await rejects(submit(alice, aliceSpins[0]!, post(2)), /already has a share/);

    // Fraud: wrong author, post outside the season / after submission, missing spin reference, not public.
    await rejects(
      review(s1.id, "approve", goodEvidence({ author_username: "someone_else" })),
      /linked X account/,
    );
    await rejects(
      review(
        s1.id,
        "approve",
        goodEvidence({ post_created_at: new Date(Date.now() + 3600_000).toISOString() }),
      ),
      /before it was submitted/,
    );
    await rejects(
      review(
        s1.id,
        "approve",
        goodEvidence({
          post_created_at: new Date(Date.parse(String(season.starts_at)) - 1000).toISOString(),
        }),
      ),
      /during the season/,
    );
    await rejects(review(s1.id, "approve", goodEvidence({ references_spin: false })), /share code/);
    await rejects(review(s1.id, "approve", goodEvidence({ public: false })), /public/);

    // Two approvals for the same UTC day race: one rewarded, one limit_reached.
    const s2 = await submit(alice, aliceSpins[1]!, post(3));
    const [r1, r2] = await Promise.all([
      review(s1.id, "approve", goodEvidence()),
      review(s2.id, "approve", goodEvidence()),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), ["approved", "limit_reached"]);
    const [{ total: after }] = await sql<
      { total: string }[]
    >`select total::text from public.season_scores where season_id = ${season.id} and user_id = ${alice}`;
    assert.equal(Number(after) - Number(before), 2);
    // Reversing the share points does not reopen the day.
    const [led] = await sql<
      { id: string }[]
    >`select id from public.points_ledger where reward_subtype = 'social_share' and user_id = ${alice}`;
    await rpc(sql, "reverse_points", {
      _ledger_id: led!.id,
      _amount: null,
      _reason: "post deleted later",
      _actor: ADMIN_ACTOR,
    });
    const s3 = await submit(alice, aliceSpins[2]!, post(4));
    const r3 = await review(s3.id, "approve", goodEvidence());
    assert.equal(r3.status, "limit_reached");

    // UTC boundaries: shares submitted on different UTC days get separate slots.
    const s4 = await submit(alice, aliceSpins[3]!, post(5));
    await sql`update public.social_shares set award_day = (now() at time zone 'UTC')::date + 1, submitted_at = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '1 day' where id = ${s4.id}`;
    const [b1] = await sql<
      { d: string }[]
    >`select (timestamptz '2026-10-09 23:59:59.999+00' at time zone 'UTC')::date::text d`;
    const [b2] = await sql<
      { d: string }[]
    >`select (timestamptz '2026-10-10 00:00:00+00' at time zone 'UTC')::date::text d`;
    assert.notEqual(b1!.d, b2!.d);
    const r4 = await review(
      s4.id,
      "approve",
      goodEvidence({ post_created_at: new Date(Date.now() - 1000).toISOString() }),
    );
    assert.equal(r4.status, "approved", "a new UTC day has its own slot");

    // Rejections need a reason; rate limits and disabled rewards.
    const bobShare = await submit(
      bob,
      bobSpins[0]!,
      "https://twitter.com/bob_apes/status/1845000000000000099",
    );
    await rejects(review(bobShare.id, "reject", {}, ""), /reason/);
    assert.equal((await review(bobShare.id, "reject", {}, "post not found")).status, "rejected");
    await sql`update public.app_config set value = value || '{"max_submissions_per_hour": 1}' where key = 'social'`;
    const more = await play(bob, 1);
    await rejects(
      submit(bob, more[0]!, "https://x.com/bob_apes/status/1845000000000000100"),
      /Too many submissions/,
    );
  } finally {
    await db.drop();
  }
});

test("share rewards switched off: submissions are refused (UI hides “Earn +2”)", async () => {
  const db = await createDb({ label: "socialoff" });
  const sql = db.sql as Sql;
  try {
    await verifyEconomics(sql);
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    await activeSeason(sql);
    const u = await createUser(sql);
    await buySpins(sql, u, 5);
    const d = await drawConfirmed(sql, u, 1, version);
    const [{ i }] = await sql<
      { i: number }[]
    >`select onchain_index as i from public.prizes where name = 'Banana Chip'`;
    await settle(sql, d.spinIds[0]!, i!, d.requestId);
    await rpc(sql, "link_x_account", {
      _user_id: u,
      _username: "someone",
      _x_user_id: null,
      _verification: "self_declared",
      _evidence: {},
    });
    await rejects(
      rpc(sql, "submit_social_share", {
        _user_id: u,
        _spin_id: d.spinIds[0],
        _post_url: "https://x.com/someone/status/1845000000000000001",
      }),
      /turned off/,
    );
  } finally {
    await db.drop();
  }
});
