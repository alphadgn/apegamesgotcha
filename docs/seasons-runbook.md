# Seasons, ledger and draws — runbook

This branch adds season-based leaderboards with an append-only points ledger, verified wallet
links, historical (2025) NFT snapshot claims, audited X-share rewards, sponsored-spin budgets and a
reworked Chainlink VRF draw pipeline. **Nothing here is live until an admin completes the
real-world configuration below.** Every season starts as a draft and the new features default to
disabled.

## 1. What changed

### Scoring (frozen per season)

| Source | Points | Notes |
| --- | --- | --- |
| Eligible 2025 NFT held at the snapshot block | 100 per token | Verified with an archive RPC `ownerOf` at the snapshot block. Each token counts once, globally. |
| Fulfilled spin | 10 | Awarded only when the VRF result is settled. |
| Prize bonus | common 25 · rare 100 · epic 250 · legendary 500 | Per-prize overrides are allowed, including 0. Legacy `prizes.points` is never added on top. |
| Verified X share | 2 | At most one per UTC day, one per spin. |
| Referrals | off | — |

- **Limits:** 10 spins per rolling 24 h and 100 per season. Pending reservations count toward both. A refund releases capacity exactly once.
- **Frozen at reservation:** each spin captures the rule version and the prize→bonus mapping when it is reserved.
- **Projection:** the UI projects points from the *currently available* pool. With the initial 600/280/100/20 pool that is 78 bonus + 10 = 88 per spin, but only while every prize is in stock.
- **Integer safety:** all scores are `bigint` in Postgres and are carried as strings in TypeScript.

### Seasons

- Statuses run one way: `draft → active → settling → finalized`.
- Rules, the time window and the snapshot config freeze when a season is activated.
- Finalizing writes immutable standings (version 1) with:
  - a rules hash,
  - a ledger watermark (the max ledger id),
  - a sha256 export hash.
- A correction never edits finalized standings. It writes a superseding version with a reason.
- Points earned before this change are archived as the finalized `legacy-preseason` season.

### Ledger

- `points_ledger` gains:
  - season, source type/id and subtype,
  - rule version and effective time,
  - a reversal reference and metadata.
- Each original award is unique per (season, user, source, subtype).
- The ledger is append-only (enforced by triggers). Its rows maintain `season_scores` atomically.
- Reversals must reference an original entry, carry a reason, and can never exceed what remains of it.
- Ranking order:
  1. total, descending;
  2. time the total was reached, ascending;
  3. user id, ascending.

  Ordinals are consecutive. Only public aliases and opaque `ape_…` ids are exposed.
- Historical backfill is off by default. Admins get a dry-run report before applying it.

### Security

Hardening:
- RLS is on everywhere.
- Client writes are revoked on all public tables. Mutating RPCs are service-role only.
- Every function sets `search_path = ''`.
- The first-registrant-becomes-admin bootstrap is removed, as are names derived from email addresses.

Identity:
- Wallet links require a SIWE signature with a consume-once nonce. Contract wallets are supported via ERC-1271.
- Accounts are never auto-merged. A wallet already linked elsewhere is refused.

### Draws

VRF is the only source of outcomes. Every draw goes through these steps:

1. **Reserve** a batch, keyed by an idempotency key. All draws are serialized through one global coordination row.
2. **Sign** the transaction and store it durably before broadcasting.
3. **Broadcast.** Retries resend the *same* signed transaction.
4. **Confirm.** The requestId comes from confirmed events, never from a simulation.
5. **Settle** each spin atomically and replay-safely.

Other draw rules:
- A refund happens only on a proven pre-broadcast failure, a canonical revert, or a dropped nonce.
- `cancelRequest` was removed from the contract. The owner can only pause new requests; pending callbacks still settle.
- Odds publication locks out new draws, then reconciles stock as `min(db, chain + audited restocks)`. It never refills stock from stale database values.

### Economics

- Prizes are either points-only or real.
- A real prize's cost and stock are "unverified" until an admin confirms them.
- The admin Economics tab shows expected and worst-case cost per draw, outstanding liabilities and fulfillment status.
- Burn, grant and free spins are funded from sponsored budgets. These start paused, and they pause themselves and raise an alert when exhausted.
- Purchases stay gated by `economics_status`.

### X shares

- Every share carries the spin's public URL (`/spin/<id>`).
- The branded card reads "The Games Are Calling. Take Your Spin."
- Verification is `disabled` (the default), `manual` (audited admin review) or `x_api` (bearer token).
- Post URLs are normalized to numeric ids. Ids are unique, and submissions are rate-limited.
- "Earn +2" is hidden while verification is disabled.

## 2. Remaining real-world configuration (required before activation)

None of these values were invented. Each must come from the project owner.

1. **2025 collection(s).** Confirm the intended contract(s), chain, deploy block, snapshot block and that block's hash.
   - The seeded ApeChain contract `0x8Bb7…` is a **candidate only**.
   - Do this in Admin → 2025 snapshot, then run "Index Transfer logs", then "Confirm & mark ready".
2. **Archive RPC URL per chain**, in `app_config.snapshot.archive_rpc_urls`. Snapshot ownership is never inferred from current ownership; if the RPC is unavailable, claims stay pending.
3. **Season.** Name, slug, start, end and settlement dates, rules review, and the snapshot collection ids. Activate it in Admin → Seasons.
4. **X verification method.** Set `social.verification` to `manual` or `x_api`. `x_api` also needs `X_BEARER_TOKEN`. Set `social.site_origin` to the public site origin.
5. **Real prize inventory and unit costs.** Verify each in Admin → Economics. Points-only prizes need no cost.
6. **Sponsored budgets** for burn, grant and free spins: amount, low-water mark, then unpause.
7. **Production VRF.**
   - Chain, coordinator address (`vrf.coordinator`), subscription id and its funding.
   - Operator key funding.
   - Deploy the **replacement** GotchaVRF contract: the old one has `cancelRequest`. See `contracts/README.md`.
   - Transfer ownership to a multisig.
   - Add the contract as a subscription consumer.
   - Publish the prize pool.
8. **SIWE allowed origins** (`siwe.allowed_origins`), for example `https://<your-domain>`.
9. **Worker cron.** Schedule `POST /api/worker/settle` every minute with `Authorization: Bearer $LOVABLE_CRON_SECRET`. The Setup checklist turns green once the heartbeat is recent.
10. **Secrets** listed in `.env.example`, as project secrets.
11. **Admins.** The bootstrap was removed. Grant the admin role explicitly via SQL as the service role:
    `insert into user_roles (user_id, role) values ('<uuid>', 'admin');`

Purchases, season activation and contract deployment are deliberately **not** done by this change.

## 3. Operating

- **Monitors.** `run_db_monitors()` (invoked by the worker) and the settlement worker raise `ops_alerts`. Alerts cover:
  - stuck or unfulfilled draws, result/request/reorg conflicts and settlement deadlines,
  - ledger or inventory drift and snapshot/verification failures,
  - a VRF coordinator change (which also pauses draws), a missing consumer registration or a low subscription balance,
  - low or exhausted budgets, and worker step errors.

  Review them in Admin → Draws & alerts. A stale worker heartbeat shows in the Setup checklist and on the Settlement card.
- **Pause.** "Pause new draws" stops reservations. In-flight draws still settle.
- **Corrections after finalization.** Admin → Seasons → correct. This writes a new standings version and keeps the old one.
- **CSV exports** are formula-safe: cells starting with `= + - @` are quote-prefixed, except plain numbers.

## 4. Checks run for this change

All of these ran locally in the development container. Results are as reported.

| Check | Command | Result |
| --- | --- | --- |
| DB integration (fresh + upgraded schema, RLS, ledger, draws, seasons, NFT/social, economics) | `cd db-tests && npm install && PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres npm test` | 66 / 66 pass |
| Generated Supabase types are current | `node db-tests/gen-types.mjs --check` | up to date |
| Contract tests | `cd contracts && forge test` (Foundry 1.5.1, solc 0.8.24) | 15 / 15 pass |
| TS unit tests (projection 78/88, bonuses, URL normalization, spin reference, CSV) | `bun test tests/unit` | 14 / 14 pass |
| Type check | `npx tsc --noEmit -p .` | 0 errors |
| Production build | `npx vite build` | succeeds |
| Lint | `npx eslint src --rule 'prettier/prettier: off'` | 10 errors, all pre-existing on `main` (`no-explicit-any`, `prefer-const` in untouched code); no new rule violations. New files are Prettier-formatted. Prettier formatting errors remain in pre-existing modified files, as on `main`. |

**Not run (need real infrastructure):**
- live RPC / archive-RPC calls;
- Chainlink VRF on a live network;
- X API calls;
- Privy and Coinbase calls;
- the Lovable cron;
- applying the migrations to the production Supabase project.

The `db-tests` harness uses a Supabase-compatible baseline (`db-tests/supabase_baseline.sql`), not the hosted platform.

## 5. Migrations

The migrations are forward-only, in this order:

1. `20261009100000_security_hardening.sql`
2. `20261009100100_seasons_ledger.sql`
3. `20261009100200_economics_draws.sql`
4. `20261009100300_identity_nft_social.sql`
5. `20261009100400_season_lifecycle_public_api.sql`
6. `20261009100500_config_defaults.sql`

They have been tested by replaying all migrations from empty, and by upgrading a database that has the current production schema plus legacy points. After a schema change, regenerate the types with `node db-tests/gen-types.mjs`.

Before applying to production:
- Take a backup.
- Check that no spins are pending. The old `begin_spins`, `finalize_spin` and `refund_spins` functions are dropped, and legacy pending spins are handled by the worker.
- Deploy the app and the migrations together.
