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
- Guide event knowledge (ApeFest 2026, Charleston): `src/lib/event-knowledge.server.ts` uses Firecrawl (`FIRECRAWL_API_KEY`) to scrape/search boredapeyachtclub.com only, caches pages in `event_knowledge` (refresh every `event_info.refresh_hours`), and the guide also gets a `search_apefest_info` tool. Scraped text is quoted as untrusted reference data in the system prompt.
