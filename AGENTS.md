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
- Database migration rules live in `drizzle/AGENTS.md`.
- Gotcha Treasury, phase 1 (Oct 16, drizzle 0022, super admin → Admin → Treasury, `src/components/admin/TreasuryPanel.tsx`, `src/lib/treasury.functions.ts`): deploys `GotchaFeeSplitter` (source `src/contracts/GotchaFeeSplitter.sol`, ABI `GotchaFeeSplitter.abi.json`, constants `src/contracts/splitter.ts`). Compiled in the browser by a classic Web Worker `public/solc/solc-worker.js` that loads the self-hosted official solc-js `public/solc/soljson-v0.8.24+commit.e11b9ed9.js` (from the `solc@0.8.24` npm package) and calls `solidity_compile` directly; settings optimizer 200 runs, evmVersion shanghai, file name `GotchaFeeSplitter.sol` (changing the source, file name or settings changes the bytecode: regenerate `EXPECTED_BYTECODE_SHA256` = SHA-256 of the creation bytecode hex text). Deploy is blocked unless the browser's bytecode matches that fingerprint; deploys from the injected wallet (switches/adds ApeChain 33139 or Curtis 33111, Curtis default). `adminRecordSplitter` checks the receipt, that the tx input minus the 10 constructor-arg words hashes to the fingerprint, and reads owner/keeper/getBuckets from the contract before saving `treasury_splitters` (one `is_active` per chain). The page shows ApeScan verification settings, constructor args, Copy source / standard JSON input. Fee routing plan (later phase): Refill payments call `deposit()` with the purchase ID appended (the splitter has `receive()` but no `fallback()`, so a plain transfer WITH data would revert); tested on a local chain.
