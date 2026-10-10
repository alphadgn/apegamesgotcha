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
- Grant deletion uses a stationary pointer-capture surface and motion values for the moving row; this avoids touch coordinate drift and per-frame React renders while preserving vertical scrolling.
- Empty-spin guidance is injected into `GotchaMachine` as an optional callback so reusable machine logic stays independent of page-specific refill controls.
- USD-priced native-APE checkout fetches Coinbase spot rates server-side and locks the exact wei amount in a purchase before wallet approval; never trust client conversion or silently fall back to a fixed rate.
- Purchase settings reach players through a narrow authenticated server function; do not broaden configuration-table read policies for checkout.

- Player guide chat: streaming endpoint at src/routes/api/guide-chat.ts (server route, bearer-authed), handler in src/lib/guide-chat.server.ts (Claude via Lovable AI Gateway /v1/messages), one conversation per user persisted in guide_messages; UI at src/routes/_authenticated/guide.tsx using AI Elements + useChat.
- App-wide font is set once in src/styles.css with a universal !important rule — component-level font choices are intentionally overridden.
- Sign-in and Refill windows are app-wide: open them with `openSignIn()` / `openRefill()` from `src/components/wallet/walletUi.ts`; `WalletHost` (root shell) renders them inside one lazily loaded PrivyProvider (`PrivyLayer`).
- Privy is the sign-in front door; Supabase stays the session of record. `privySignIn` verifies the Privy access token (JWKS) + reads linked accounts with `PRIVY_APP_SECRET`, maps to a Supabase user (Privy DID → verified email → linked wallet) and returns a magic-link token hash the browser exchanges with `verifyOtp`. Players without a wallet get a Privy embedded wallet, which becomes `wallets.is_default`.
- Guide event knowledge (ApeFest 2026, Charleston; official ApeGames account @goApeGames on X, stored as `event_info.games_handle`): `src/lib/event-knowledge.server.ts` uses Firecrawl (`FIRECRAWL_API_KEY`) to scrape/search boredapeyachtclub.com only, caches pages in `event_knowledge` (refresh every `event_info.refresh_hours`), and the guide also gets a `search_apefest_info` tool. Scraped text is quoted as untrusted reference data in the system prompt.
- Admin spin grants come in two kinds (`spin_credits.kind` / `spin_grants.kind`): `real` = paid-equivalent on-chain spin, `demo` = practice spin on the demo machine (no prizes/points, redeemed via `use_demo_spins`, no 30-minute wait). Granted spins are usable immediately, spent before purchased ones and exempt from per-player spin limits; the admin Grants tab lists every grant with usage. Count only `kind = 'real'` credits as drawable spins.
- Database migrations go in `drizzle/migrations/NNNN_name.sql` with an entry in `drizzle/migrations/meta/_journal.json` (increasing `when`); Lovable applies them on sync with `drizzle-kit migrate`. Write them idempotent (`if not exists`, `create or replace`, `on conflict do nothing`). `supabase/migrations` is the older history and is not applied automatically.
- On-chain draw setup: Admin → Chainlink VRF → "Set up" (`src/lib/vrf-setup.server.ts`) creates and funds a VRF v2.5 subscription in native ETH, deploys GotchaVRF from `src/lib/gotchaVrfBytecode.server.ts` (regenerate after changing the contract), and adds it as consumer, using `VRF_OPERATOR_PRIVATE_KEY`; each step is saved to `app_config.vrf` so reruns resume. Real spins and purchases are switched on with `adminVrfSwitch` / `adminPurchaseSwitch`, which check readiness first. Players learn whether the draw is open via `getDrawStatus` (they can't read `app_config.vrf`).
- Signed-in demo spins (granted + the free one every 30 minutes, timed by the server) are drawn server-side and stored in `demo_spins`; `get_leaderboard` returns the demo board or the live board (real spins + admin adjustments) per `app_config.leaderboard.mode`. Signed-out visitors' demo spins stay in the browser.
- Wallet transactions (Refill payments, NFT burns) share `usePrivyWalletAdapter` / `useInjectedWalletAdapter`; long confirm loops must reset their cancel flag on mount (React dev mounts twice).

