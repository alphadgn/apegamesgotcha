# Suggested changes - ApeGames Gotcha (post Hashlock audit)

Companion to `Hashlock-Certified-Audit-ApeGames-Gotcha.pdf`. Apply these before treating the reviewed fixes as live on Base / ApeChain.

## Must do (security)

1. **Redeploy GotchaVRF on Base** from `contracts/src/GotchaVRF.sol` after AG-01 / AG-03.
   - AG-01: short `randomWords` cancel leftover Pending spins and emit `RequestCancelled`.
   - AG-03: `setPool` reverts when `remaining != 0 && weight == 0`. The app's `poolArrays` (`src/lib/vrf.server.ts`) already sends `remaining = 0` for inactive or zero weight prizes, so pool syncs keep working on the new contract.
   - Update the app VRF contract address / env to the new deployment.
   - Recreate the Chainlink VRF subscription consumer + fund LINK / native as before.

2. **Redeploy ApeGamesLevels on ApeChain** from `contracts/ApeGamesLevels.sol` after AG-02 / AG-04.
   - Constructor is now `(collection, operator, burnSink)`.
   - Pass `app_config.nft.burn_address` as `burnSink` (same address players `safeTransferFrom` to).
   - Update `app_config.nft.level_contract` (or equivalent) to the new tracker.
   - Admin deploy path: `deployTracker(collection, burn_address)` in `level-tracker.server.ts`.

3. **Stop tracking `.env`**
   - Already listed in `.gitignore`.
   - Run `git rm --cached .env` if it is still in the index.
   - Rotate any non-publishable secrets that ever lived in a committed `.env`.

## Should do (ops / trust)

4. **Operator key hygiene (AG-04)**
   - Keep `VRF_OPERATOR_PRIVATE_KEY` on a dedicated EOA with a small Base float only.
   - Move GotchaVRF `owner` to a multisig via Ownable2Step when ready.
   - Alert on unexpected `PoolUpdated` / `SpinRequested` volume.

5. **App refund path for Cancelled spins**
   - Spins cancelled by AG-01 short fulfill must hit the same refund / credit path as `cancelRequest`.
   - Verify UI and backend treat `Status.Cancelled` identically in both cases.

6. **Burn sink continuity**
   - Do not change `burn_address` without calling `setBurnSink` on the tracker and migrating any NFTs sitting at the old sink (or they cannot be recorded).

## Nice to have

7. Add forge tests for `ApeGamesLevels` (recordBurn at sink, reject when still in wallet, Ownable2Step).
8. Document the prize index <-> DB `onchain_index` mapping next to `setPool` in the runbook.
9. Keep `docs/pdg/` certificate + this audit PDF in-repo for partner sharing.

## Proof

```bash
cd contracts && forge test
# expect 16/16 green
python3 docs/build-gotcha-audit.py
```
