# Season leaderboard: setup and runbook

This change adds a season-based leaderboard to ApeGames Gotcha. **It ships switched off.** No contract is
deployed, no season is active, purchases stay disabled and nothing is published. Every flow that needs
real-world facts stays disabled and shows its setup state until an admin supplies those facts.

## What players get

- **Points:** engagement scores that can't be transferred and carry no promised cash, APE or $GAMES value.
  Nothing pays out automatically.
- **Draft defaults for a new season:**
  - **100** once per eligible 2025 NFT owned at a frozen snapshot block.
  - **10** per spin Chainlink fulfils, counted only if the request was confirmed on-chain before the cutoff.
  - **Prize bonus:** common 25, rare 100, epic 250, legendary 500. Per-prize overrides are allowed, including 0.
  - **2** per verified X share, at most once per UTC day.
  - **Referrals:** off.
- **Spins that score zero:** pending, failed, refunded and NO_PRIZE results score nothing. Paid, burn, grant
  and free-entry spins all score the same.
- **Limits:** 10 spins per rolling 24 hours and 100 per season, with pending reservations counted.
- **Ranking:**
  1. Total points, highest first.
  2. Then whoever reached that total first.
  3. Then a stable internal id.

  Ranks are consecutive. A reversal re-dates the tie timestamp to the latest award that still counts.
- **What the public sees:** only an alias and avatar the player chose, an opaque public id, and scores.
- **Projection:** with the 600/280/100/20 pool, a spin is worth 78 bonus points (88 including participation)
  on average, but only while every prize is in stock. `/leaderboard` shows the live figure from the
  available pool.

## Migrations (forward-only, apply in order)

| File | What it does |
|---|---|
| `20261010090000_identity_security_hardening.sql` | <ul><li>Removes first-registrant admin bootstrapping; existing admins are kept.</li><li>Stops email-derived names and adds public alias/avatar/public id.</li><li>Browsers can no longer write tables directly.</li><li>Revokes mutating RPCs from PUBLIC/anon/authenticated.</li><li>Pins `search_path=''`.</li><li>Adds SIWE challenges and wallet/Privy link RPCs that never move wallets between accounts.</li></ul> |
| `20261010090100_seasons_and_ledger.sql` | <ul><li>Seasons and frozen rule versions.</li><li>Append-only `points_ledger` (amount/reason/ref kept; type widened to bigint) plus `season_scores` aggregates.</li><li>Audited reversals and adjustments.</li><li>Immutable finalized standings with export hash.</li><li>Public read-only RPCs.</li><li>**All existing ledger rows are archived unchanged in a finalized `legacy` season.**</li><li>Drops `get_leaderboard`, which exposed user ids and email-derived names.</li></ul> |
| `20261010090200_economic_controls.sql` | <ul><li>Prize classification.</li><li>Cost lines (unknown = unverified, never zero).</li><li>Reserves.</li><li>Sponsored budgets and atomic reservations.</li><li>Purchase gate.</li></ul> |
| `20261010090300_nft_snapshots_and_burns.sql` | <ul><li>Snapshot collections. The candidate ApeChain contract is seeded as a **candidate**, with no snapshot block.</li><li>Transfer-log index.</li><li>Global one-time claims.</li><li>Burns keyed by chain/contract/token and chain/tx/log index.</li></ul> |
| `20261010090400_draw_batches_and_settlement.sql` | <ul><li>Draw batches with idempotency keys.</li><li>Durable signed submissions and operator nonces.</li><li>Settlement using the captured rules.</li><li>Pool publications and restocks.</li><li>Ops alerts.</li><li>Machine readiness.</li><li>Removes `begin_spins`, `refund_spins` and `finalize_spin`, which allowed timeout refunds.</li></ul> |
| `20261010090500_verified_x_shares.sql` | <ul><li>X accounts.</li><li>Share submissions and reviews.</li><li>UTC-day award slots.</li></ul> |
| `20261010090600_season_lifecycle_and_monitors.sql` | <ul><li>Draft, activate, settle and finalize, plus corrections.</li><li>Backfill dry-run.</li><li>Published rules.</li><li>Monitor scan.</li><li>Final privilege sweep.</li></ul> |

**Duplicate historical migrations.** `20261006173505_*`, `20261006173526_*` and `20261007102124_*` are
Lovable copies of `20261002203000`, `20261006170000` and `20261007100000`. They are idempotent
(`if not exists`, `create or replace`, `on conflict do nothing`) and replay cleanly, so they are left as
they are; editing applied history is unsafe. Two other notes:

- `20261007085143_*` is a one-line config update.
- The generated types showed that the live database had not yet applied `20261008190000_event_knowledge`.
  Apply every pending migration in filename order.

**Applying the migrations.** The Supabase connector here has no access to project `smlrgasritolkfkgrjnw`,
so apply the migrations through Lovable (ask it to apply pending Supabase migrations) or with
`supabase db push`. They are tested on a fresh replay and as an upgrade over a populated pre-change database.

## Setup order (real-world facts the team must supply)

1. **Apply the migrations.** Then regenerate types if Lovable doesn't:
   `TEST_DATABASE_URL=… npx tsx scripts/gen-supabase-types.ts > src/integrations/supabase/types.ts`.
   This works against a replay database, or set `TYPES_DATABASE_URL` to point at a real one.
2. **Admins:** the first-user bootstrap is gone. Grant a role deliberately in SQL:
   `insert into user_roles(user_id, role, granted_at, note) values ('<uuid>', 'admin', now(), 'why');`
3. **Snapshot collection** (Admin → Snapshots):
   1. Confirm `0x8Bb7b20291A9fA2F25705b8487194B410808c28b` on ApeChain 33139 is the intended **2025**
      collection.
   2. Enter the snapshot block number and its block hash. Set "index from" to the deploy block.
   3. Add the `ARCHIVE_RPC_URL_33139` secret.
   4. Run **Index transfers** until it reports complete.
   5. Click **Mark verified…** and describe the evidence.
4. **Prizes and economics** (Admin → Prizes & odds, Admin → Economics):
   1. Classify every prize.
   2. For real prizes (VIP pass, Gold Crate?), enter verified finite stock and costs, or reserved funding,
      with evidence. The seeded 500/20 numbers are not proof.
   3. Record measured gas and VRF costs per draw.
   4. Fund sponsored budgets for burn, grant and free-entry spins.
   5. Record reserves before opening purchases.
5. **VRF:**
   1. Deploy the **new** GotchaVRF. It has no owner cancellation; any older deployment must be replaced
      (see `contracts/README.md`).
   2. Fund the subscription and add the contract as a consumer.
   3. Set `vrf.contract`, `vrf.chain_id`, `vrf.rpc_url` and `vrf.min_confirmations`. Set
      `vrf.min_subscription_balance` (wei) for alerts.
   4. Add the `VRF_OPERATOR_PRIVATE_KEY` secret.
   5. Publish the pool.
6. **Settlement worker:**
   1. Add the `LOVABLE_CRON_SECRET` secret.
   2. Schedule `POST /api/cron/settle` with `Authorization: Bearer <secret>` every minute.
   3. It settles draws for every player, resends stored transactions, retries snapshot claims, checks VRF
      funding and raises alerts.
7. **X verification:** set `X_API_BEARER_TOKEN` for automatic checks (fixed `api.x.com` endpoint), or keep
   the audited manual review. Share rewards stay off unless the season's rules set `social_enabled: true`.
8. **Season** (Admin → Seasons):
   1. Create a draft with real UTC start, exclusive end and settlement deadline.
   2. Link the verified collection(s) and edit the rules.
   3. **Activate…** by typing the slug. This freezes the rules, hashes them and freezes the collections.
      Never automatic.
9. **Switch draws on:** `vrf.enabled: true`. **Last of all, open purchases:** `purchase.enabled: true`. Then publish.

## Operating a season

- **Cutoff.** The worker moves an active season to `settling` once `now ≥ ends_at`.
  - Claims and share submissions are accepted only before the cutoff.
  - Verification can finish during the grace period, up to the settlement deadline.
- **Finalize** (Admin → Seasons) is refused while any of these remain: pending spins, unreconciled batches,
  pending or unavailable snapshot claims, pending share reviews, or ledger drift.
  - A missed settlement deadline raises a critical alert. Nothing is cancelled.
- **Corrections after finalization:**
  1. Reverse on the ledger (Admin → Ledger). Reversals need a reason and can't exceed the remaining amount.
  2. **Publish correction…** creates a superseding standings version with a reason.
  3. Exports are formula-safe CSV.
- **Draw conflicts** (Admin → Operations):
  - Reorgs, mismatched events and operator nonces taken by another transaction pause new draws.
  - **Re-check: on-chain** resumes once the chain shows the request.
  - **Prove never mined** returns credits only when all three hold: every spin reads `None`, no submission
    has a receipt, and the nonce was consumed by another transaction at finalized depth.
- **Pool changes:** settle everything first. Publication reconciles against the contract.
  - Database stock higher than on-chain remaining is refused, because stale values are never republished.
    Raise stock only with **+Stock** (audited restock).
- **Historical backfill** is off by default. The dry run (Admin → Seasons → Backfill dry run) reports what
  would score. NFT points are never backfilled from current ownership.

## Tests

```bash
npm run typecheck
npm run build
npm run test:unit
# Needs PostgreSQL 15+ (TEST_DATABASE_URL); each test creates and drops its own database:
npm run test:db
# Needs Foundry (forge + anvil) and `cd contracts && npm install && forge build` first:
npm run test:contracts
npm run test:chain
```

`supabase/tests/support/supabase-shim.sql` reproduces the Supabase pieces the migrations rely on:
roles, `auth.uid()`, and the default grants to the API roles.
