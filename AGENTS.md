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

- Subdirectories have their own `AGENTS.md` (notably `src/AGENTS.md`, which holds the app architecture rules); read it before changing files there.
- Database migrations go in `drizzle/migrations/NNNN_name.sql` with an entry in `drizzle/migrations/meta/_journal.json` (increasing `when`); Lovable applies them on sync with `drizzle-kit migrate`. Write them idempotent (`if not exists`, `create or replace`, `on conflict do nothing`). `supabase/migrations` is the older history and is not applied automatically. Storage steps (`storage.buckets` / policies on `storage.objects`) are each wrapped in `do $outer$ … exception when others … $outer$` so a permission error there can't stop the rest of a migration; evidence (Oct 11) suggests the live data
