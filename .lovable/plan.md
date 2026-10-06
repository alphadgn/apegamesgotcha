# Application-wide event background

## What will change
- Add the uploaded event collage as a hosted app image.
- Move the shared background to the application shell so every public, sign-in, player, admin, loading, and error page uses it.
- Keep a dark readability overlay behind all page content and preserve the existing sticky header treatment.
- Remove duplicate page-level background instances from the landing and sign-in pages.
- Verify the main pages at desktop and mobile sizes and confirm build health.

## Technical details
- Keep the artwork rendering in `PageArtwork` and mount it once from the root layout.
- Use the existing semantic background token for the overlay.
- No authentication, wallet, gacha, leaderboard, or administration behavior will change.
