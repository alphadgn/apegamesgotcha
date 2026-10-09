<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Shared page artwork is mounted once from the root shell through `PageArtwork`; this keeps every application page visually consistent.
- Empty-spin guidance is injected into `GotchaMachine` as an optional callback so reusable machine logic stays independent of page-specific refill controls.
- USD-priced native-APE checkout fetches Coinbase spot rates server-side and locks the exact wei amount in a purchase before wallet approval; never trust client conversion or silently fall back to a fixed rate.
- Purchase settings reach players through a narrow authenticated server function; do not broaden configuration-table read policies for checkout.

- Player guide chat: streaming endpoint at src/routes/api/guide-chat.ts (server route, bearer-authed), handler in src/lib/guide-chat.server.ts (Claude via Lovable AI Gateway /v1/messages), one conversation per user persisted in guide_messages; UI at src/routes/_authenticated/guide.tsx using AI Elements + useChat.
- App-wide font is set once in src/styles.css with a universal !important rule — component-level font choices are intentionally overridden.
- Sign-in and Refill windows are app-wide: open them with `openSignIn()` / `openRefill()` from `src/components/wallet/walletUi.ts`; `WalletHost` (root shell) renders them inside one lazily loaded PrivyProvider (`PrivyLayer`).
- Privy is the sign-in front door; Supabase stays the session of record. `privySignIn` verifies the Privy access token (JWKS) + reads linked accounts with `PRIVY_APP_SECRET`, maps to a Supabase user (Privy DID → verified email → linked wallet) and returns a magic-link token hash the browser exchanges with `verifyOtp`. Players without a wallet get a Privy embedded wallet, which becomes `wallets.is_default`.
- Guide event knowledge (ApeFest 2026, Charleston; official ApeGames account @goApeGames on X, stored as `event_info.games_handle`): `src/lib/event-knowledge.server.ts` uses Firecrawl (`FIRECRAWL_API_KEY`) to scrape/search boredapeyachtclub.com only, caches pages in `event_knowledge` (refresh every `event_info.refresh_hours`), and the guide also gets a `search_apefest_info` tool. Scraped text is quoted as untrusted reference data in the system prompt.
- Seasons & points (see docs/seasons-runbook.md): `points_ledger` is append-only and season-scoped; never UPDATE/DELETE it — award via `ledger_award`, undo via `reverse_ledger_entry` (reason required), adjust via `admin_adjust_points`. `season_scores` is maintained by ledger triggers only. Finalized standings are immutable; corrections create a new standings version. Scores are bigint and travel as strings in TS (`src/lib/seasonRules.ts`).
- Security baseline: clients never write tables directly — all mutations go through server functions using the service role (`src/lib/helpers.server.ts`); mutating RPCs are revoked from anon/authenticated and every function uses `set search_path = ''`. Admins are granted explicitly in `user_roles` (no first-user bootstrap). Public surfaces expose only `public_id` / `public_alias` / `avatar_key`.
- Draws: Chainlink VRF is the only outcome source. Flow is reserve batch (idempotency key, global `draw_coordination` lock) → sign & store → broadcast (resend the same raw tx) → confirm requestId from events → settle. Refund only on proven pre-broadcast failure, canonical revert or dropped nonce. Settlement runs from the cron-authed worker `POST /api/worker/settle`; `getMachineReadiness` is the narrow public readiness check.
- Wallet links require SIWE (`src/lib/siwe.server.ts`, consume-once nonces, origins from `app_config.siwe.allowed_origins`); never auto-merge accounts. Snapshot NFT points need an archive RPC `ownerOf` at the configured snapshot block — never infer from current ownership; the seeded 0x8Bb7… collection is a candidate only.
- DB tests: `cd db-tests && npm test` (local Postgres, Supabase baseline); regenerate `src/integrations/supabase/types.ts` with `node db-tests/gen-types.mjs`. TS unit tests: `bun test tests/unit`. Contracts: `cd contracts && forge test`.
