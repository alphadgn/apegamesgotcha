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
