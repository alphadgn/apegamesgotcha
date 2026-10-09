import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, createUser, rejects, rpc, setRole, type Sql } from "./harness";
import {
  activeSeason,
  ADMIN_ACTOR,
  buySpins,
  CHAIN_ID,
  CONTRACT,
  enableVrf,
  publishPool,
  verifyEconomics,
} from "./fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ledger: append-only, reversals, tie timestamps, ordinal ranks, bigint totals", async () => {
  const db = await createDb({ label: "ledger" });
  const sql = db.sql;
  try {
    const s = await activeSeason(sql, { slug: "ledger-s" });
    const [a, b, c, d, e] = [
      await createUser(sql),
      await createUser(sql),
      await createUser(sql),
      await createUser(sql),
      await createUser(sql),
    ];
    const adj = async (u: string, amount: number | bigint) =>
      (
        await rpc<{ adjust_points: string }>(sql, "adjust_points", {
          _season_id: s.id,
          _user_id: u,
          _amount: amount,
          _reason: "test adjustment",
          _actor: ADMIN_ACTOR,
        })
      )[0]!.adjust_points;
    const board = async () =>
      rpc<{ rank: string; public_id: string; total_points: string }>(
        sql,
        "get_season_leaderboard",
        { _season_id: s.id, _limit: 100, _offset: 0 },
      );
    const pid = async (u: string) =>
      (
        await sql<{ public_id: string }[]>`select public_id from public.profiles where id = ${u}`
      )[0]!.public_id;

    const a1 = await adj(a, 100); // t1
    await sleep(20);
    const a2 = await adj(a, 50); // t2
    await sleep(20);
    await adj(b, 150); // t3: same total as A, reached later
    let rows = await board();
    assert.deepEqual(
      rows.map((r) => r.public_id),
      [await pid(a), await pid(b)],
      "earlier time to reach the total wins the tie",
    );
    assert.deepEqual(
      rows.map((r) => r.rank),
      ["1", "2"],
    );

    // Partial reversal of A's +50 keeps A's tie time at t2 (that award still contributes).
    await rpc(sql, "reverse_points", {
      _ledger_id: a2,
      _amount: 20,
      _reason: "duplicate share found",
      _actor: ADMIN_ACTOR,
    });
    rows = await board();
    assert.deepEqual(
      rows.map((r) => [r.public_id, r.total_points]),
      [
        [await pid(b), "150"],
        [await pid(a), "130"],
      ],
    );
    // Reversing the rest: A's total is back to 100 reached at t1.
    await rpc(sql, "reverse_points", {
      _ledger_id: a2,
      _amount: null,
      _reason: "duplicate share found",
      _actor: ADMIN_ACTOR,
    });
    await sleep(20);
    await adj(c, 100); // C reaches 100 after A's t1
    rows = await board();
    assert.deepEqual(
      rows.map((r) => r.public_id),
      [await pid(b), await pid(a), await pid(c)],
    );
    const [tie] = await sql<{ t: Date; created: Date }[]>`
      select sc.total_reached_at as t, l.effective_at as created from public.season_scores sc join public.points_ledger l on l.id = ${a1}
       where sc.season_id = ${s.id} and sc.user_id = ${a}`;
    assert.equal(
      tie!.t.getTime(),
      tie!.created.getTime(),
      "tie time recomputed to the surviving award",
    );

    await rejects(
      rpc(sql, "reverse_points", {
        _ledger_id: a2,
        _amount: 1,
        _reason: "again please",
        _actor: ADMIN_ACTOR,
      }),
      /0 remain/,
    );
    await rejects(
      rpc(sql, "reverse_points", {
        _ledger_id: a1,
        _amount: 101,
        _reason: "too much",
        _actor: ADMIN_ACTOR,
      }),
      /100 remain/,
    );
    await rejects(
      rpc(sql, "reverse_points", {
        _ledger_id: a1,
        _amount: 1,
        _reason: "no",
        _actor: ADMIN_ACTOR,
      }),
      /reason/,
    );
    const [rev] = await sql<
      { id: string }[]
    >`select id from public.points_ledger where reverses_id = ${a2} limit 1`;
    await rejects(
      rpc(sql, "reverse_points", {
        _ledger_id: rev!.id,
        _amount: 1,
        _reason: "reverse a reversal",
        _actor: ADMIN_ACTOR,
      }),
      /cannot itself be reversed/,
    );

    // Same timestamp → stable user id order; ranks stay consecutive.
    await sql.begin(async (tx) => {
      await setRole(tx as unknown as Sql, "service_role");
      for (const u of [d, e])
        await tx`select public.adjust_points(${s.id}::uuid, ${u}::uuid, 77::bigint, 'same instant', ${ADMIN_ACTOR}::uuid)`;
    });
    rows = await board();
    const [first, second] = [d, e].sort();
    const ids = rows.map((r) => r.public_id);
    assert.ok(
      ids.indexOf(await pid(first!)) < ids.indexOf(await pid(second!)),
      "same instant: lower user id first",
    );
    assert.deepEqual(
      rows.map((r) => Number(r.rank)),
      rows.map((_, i) => i + 1),
      "consecutive ordinal ranks",
    );

    // Bigint-safe totals (beyond 2^53) travel as exact strings.
    const big = 9007199254740993n;
    const f = await createUser(sql);
    await adj(f, big);
    rows = await board();
    assert.equal(rows[0]!.total_points, big.toString());

    // Append-only even for the table owner.
    await rejects(sql`update public.points_ledger set amount = 1 where id = ${a1}`, /append-only/);
    await rejects(sql`delete from public.points_ledger where id = ${a1}`, /append-only/);
    await rejects(sql`truncate public.points_ledger`, /append-only|cannot truncate/);
    // Aggregates match the ledger.
    assert.equal((await rpc(sql, "ledger_drift", { _season_id: s.id })).length, 0);
  } finally {
    await db.drop();
  }
});

test("seasons: activation checks, frozen rules, unresolved items block finalisation, immutable standings, corrections", async () => {
  const db = await createDb({ label: "seasons" });
  const sql = db.sql;
  try {
    const now = Date.now();
    const mk = (
      slug: string,
      rules: Record<string, unknown> = {},
      startsMs = -3600_000,
      endsMs = 86400_000,
      deadlineMs?: number,
    ) =>
      rpc<{ id: string }>(sql, "create_season_draft", {
        _slug: slug,
        _name: slug,
        _starts_at: new Date(now + startsMs),
        _ends_at: new Date(now + endsMs),
        _settlement_deadline: new Date(now + (deadlineMs ?? endsMs + 86400_000)),
        _rules: rules,
        _notes: null,
        _actor: ADMIN_ACTOR,
      }).then((r) => r[0]!.id);

    await rejects(mk("bad-rules", { referrals_enabled: true }), /Referrals are disabled/);
    await rejects(mk("bad-rules2", { social_daily_limit: 3 }), /fixed at 1/);
    await rejects(mk("bad-rules3", { surprise: 1 }), /Unknown rule/);
    await rejects(mk("bad-dates", {}, 0, -1000), /seasons_window/);

    // NFT points need a verified, linked collection.
    const withNft = await mk("with-nft");
    await rejects(
      rpc(sql, "activate_season", { _season_id: withNft, _actor: ADMIN_ACTOR }),
      /verified snapshot collection/,
    );
    const [cand] = await sql<
      { id: string }[]
    >`select id from public.nft_collections where status = 'candidate' limit 1`;
    await rpc(sql, "set_season_collections", {
      _season_id: withNft,
      _collection_ids: [cand!.id],
      _actor: ADMIN_ACTOR,
    });
    await rejects(
      rpc(sql, "activate_season", { _season_id: withNft, _actor: ADMIN_ACTOR }),
      /not verified/,
    );

    // A short season we can run to the end in this test.
    const short = await mk("short", { nft_snapshot_points: 0 }, -60_000, 2500, 3500);
    const [act] = await rpc<{
      status: string;
      rules_hash: string;
      rule_version_id: string;
      rules: Record<string, unknown>;
    }>(sql, "activate_season", { _season_id: short, _actor: ADMIN_ACTOR });
    assert.equal(act!.status, "active");
    const [rh] = await sql<
      { h: string }[]
    >`select public.rules_hash(rules) as h from public.season_rule_versions where id = ${act!.rule_version_id}`;
    assert.equal(rh!.h, act!.rules_hash);
    await rejects(
      rpc(sql, "activate_season", { _season_id: withNft, _actor: ADMIN_ACTOR }),
      /Another season is active|not verified/,
    );
    await rejects(
      rpc(sql, "update_season_draft", {
        _season_id: short,
        _name: "x",
        _starts_at: new Date(),
        _ends_at: new Date(now + 9e6),
        _settlement_deadline: new Date(now + 9e7),
        _rules: {},
        _notes: null,
        _actor: ADMIN_ACTOR,
      }),
      /Only drafts/,
    );
    await rejects(
      sql`update public.seasons set rules = rules || '{"participation_points": 999}' where id = ${short}`,
      /frozen/,
    );
    await rejects(
      sql`update public.seasons set status = 'finalized' where id = ${short}`,
      /Invalid season transition/,
    );

    // An in-flight draw inside the season.
    await verifyEconomics(sql);
    await enableVrf(sql);
    const { version } = await publishPool(sql);
    const u = await createUser(sql);
    await buySpins(sql, u, 5);
    const [batch] = await rpc<{ id: string }>(sql, "begin_draw_batch", {
      _user_id: u,
      _idempotency_key: "pending-at-cutoff",
      _count: 1,
      _chain_id: CHAIN_ID,
      _contract: CONTRACT,
      _pool_version: version,
    });
    const v = await createUser(sql);
    await rpc(sql, "adjust_points", {
      _season_id: short,
      _user_id: v,
      _amount: 40,
      _reason: "test adjustment",
      _actor: ADMIN_ACTOR,
    });

    await sleep(3800); // past the exclusive end and the settlement deadline
    await rejects(
      rpc(sql, "finalize_season", { _season_id: short, _actor: ADMIN_ACTOR }),
      /Only settling seasons/,
    );
    const [{ advance_season_states: moved }] = (await rpc<{ advance_season_states: number }>(
      sql,
      "advance_season_states",
      {},
    )) as [{ advance_season_states: number }];
    assert.equal(moved, 1);
    await rejects(
      rpc(sql, "finalize_season", { _season_id: short, _actor: ADMIN_ACTOR }),
      /pending_spins: 1, open_draw_batches: 1/,
    );
    // A missed deadline raises an alert; nothing is cancelled.
    const alerts = await rpc<{ kind: string }>(sql, "ops_monitor_scan", {});
    assert.ok(alerts.some((a) => a.kind === "settlement_deadline"));
    const [still] = await sql<
      { status: string }[]
    >`select status from public.draw_batches where id = ${batch!.id}`;
    assert.equal(still!.status, "reserved");

    // Never signed → provably never broadcast → may be refunded; then finalisation can proceed.
    await rpc(sql, "refund_batch_prebroadcast", { _batch_id: batch!.id, _reason: "test" });
    const [fin] = await rpc<{
      version: number;
      export_hash: string;
      ledger_watermark: string;
      rules_hash: string;
      entry_count: number;
    }>(sql, "finalize_season", { _season_id: short, _actor: ADMIN_ACTOR });
    assert.equal(fin!.version, 1);
    assert.match(fin!.export_hash, /^[0-9a-f]{64}$/);
    assert.equal(fin!.rules_hash, act!.rules_hash);
    assert.equal(fin!.entry_count, 1);
    const [{ standings_export_text: csv }] = (await rpc<{ standings_export_text: string }>(
      sql,
      "standings_export_text",
      {
        _version_id: (
          await sql<
            { id: string }[]
          >`select id from public.final_standings_versions where season_id = ${short}`
        )[0]!.id,
      },
    )) as [{ standings_export_text: string }];
    assert.match(csv, /^rank,public_id,/);
    assert.ok(!csv.includes(v), "no auth ids in the export");

    await rejects(sql`update public.final_standings set total = 1`, /immutable/);
    await rejects(
      sql`delete from public.final_standings_versions where season_id = ${short}`,
      /immutable/,
    );
    await rejects(
      rpc(sql, "adjust_points", {
        _season_id: short,
        _user_id: v,
        _amount: 1,
        _reason: "late award",
        _actor: ADMIN_ACTOR,
      }),
      /not accepting points/,
    );

    // Correction: reverse on the ledger, then publish a superseding version with a reason.
    const [award] = await sql<
      { id: string }[]
    >`select id from public.points_ledger where season_id = ${short} and user_id = ${v}`;
    await rpc(sql, "reverse_points", {
      _ledger_id: award!.id,
      _amount: 15,
      _reason: "audit correction",
      _actor: ADMIN_ACTOR,
    });
    await rejects(
      rpc(sql, "supersede_final_standings", {
        _season_id: short,
        _reason: "",
        _actor: ADMIN_ACTOR,
      }),
      /Explain/,
    );
    const [v2] = await rpc<{ version: number; supersedes_id: string }>(
      sql,
      "supersede_final_standings",
      { _season_id: short, _reason: "audit correction", _actor: ADMIN_ACTOR },
    );
    assert.equal(v2!.version, 2);
    assert.ok(v2!.supersedes_id);
    const [pub] = await rpc<{ total_points: string; standings_version: number; is_final: boolean }>(
      sql,
      "get_season_leaderboard",
      { _season_id: short, _limit: 10, _offset: 0 },
      { role: "anon" },
    );
    assert.deepEqual([pub!.total_points, pub!.standings_version, pub!.is_final], ["25", 2, true]);
  } finally {
    await db.drop();
  }
});

test("legacy points are archived unchanged and cannot be altered", async () => {
  const db = await createDb({ label: "legacy" });
  const sql = db.sql;
  try {
    const [legacy] = await sql<
      { id: string; status: string }[]
    >`select id, status from public.seasons where is_legacy`;
    assert.equal(legacy!.status, "finalized");
    const u = await createUser(sql);
    await rejects(
      rpc(sql, "adjust_points", {
        _season_id: legacy!.id,
        _user_id: u,
        _amount: 5,
        _reason: "test adjustment",
        _actor: ADMIN_ACTOR,
      }),
      /archived/,
    );
    await rejects(sql`update public.seasons set name = 'x' where id = ${legacy!.id}`, /archived/);
    const listed = await rpc<{ is_legacy: boolean }>(sql, "list_seasons", {}, { role: "anon" });
    assert.ok(listed.some((s) => s.is_legacy));
  } finally {
    await db.drop();
  }
});
