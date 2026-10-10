# GotchaVRF — on-chain prize draws (Chainlink VRF v2.5)

Every gotcha capsule is drawn by this contract. The app server reserves the player's spin credit
and calls `requestSpins`. Chainlink VRF delivers a verifiable random number, and the contract picks the prize
**inside the VRF callback** from the published prize pool. The server only reads the result and
awards it. It cannot see the number in advance, choose it, or re-roll it.

Why Base: Chainlink VRF v2.5 isn't offered on ApeChain
([supported networks](https://docs.chain.link/vrf/v2-5/supported-networks)). Spin credits and the
ApeGames NFTs stay on ApeChain; only the random draw lives on Base.

## Guarantees (enforced by the contract, covered by tests)

- **One random word per capsule.** A pull of N capsules is one VRF request with N words.
- **Prize chosen on-chain** by weighted pick over prizes with stock left (`word % totalWeight`).
- **No re-rolls.** Each spin id can be requested once, ever.
- **Odds can't change mid-draw.** `setPool` reverts while any draw is pending.
- **Only the coordinator can fulfil**, and only the operator can request.
- **No cancellation or re-request.** Following Chainlink's VRF security guidance, a requested spin can only
  leave `Pending` through Chainlink's answer. If a request is slow (e.g. the subscription ran low), top up the
  subscription; the app keeps the player's credit reserved and settles the spin when the answer arrives.
- **Pause is for new requests only.** `setRequestsPaused(true)` (owner) stops new draws; callbacks for draws
  already requested are always processed.

### Trust assumptions

- The **owner** can change the VRF coordinator (`setCoordinator`, inherited from Chainlink's
  `VRFConsumerBaseV2Plus`), the VRF config and the operator. Keep the owner on a multisig/hardware wallet and
  watch for `CoordinatorSet`, `VrfConfigUpdated` and `OperatorUpdated` events.
- The **operator** (app server) can request draws and publish the pool, but cannot choose outcomes.

## Replacing an existing deployment (required for this version)

Contract source changes do **not** change contracts that are already deployed. Earlier versions of GotchaVRF
had an owner `cancelRequest` escape hatch; this version removes it. If an older GotchaVRF was ever deployed:

1. Pause it (old versions: stop the app from requesting by setting `vrf.enabled: false`).
2. Wait until every pending request is fulfilled and settled (Admin → Operations shows the settlement queue).
3. Deploy this version, add it as a consumer, publish the pool to it, then point `vrf.contract` at it.
4. Optionally remove the old consumer from the subscription. Keep `vrf.rpc_by_chain` covering any chain that
   still has unsettled spins: settlement always uses each spin's captured chain and contract.

## Setup

```bash
cd contracts
npm install                                  # @chainlink/contracts
forge install foundry-rs/forge-std --no-git  # test library (lib/ is git-ignored)
forge test -vv                               # 16 tests incl. callback-gas, pause and fuzz
```

1. **Create a server wallet** (the *operator*) and fund it with a little Base ETH for gas.
2. **Create a VRF subscription** at <https://vrf.chain.link> on Base Sepolia (testnet) or Base,
   and fund it with LINK (or ETH, if you deploy with `VRF_NATIVE_PAYMENT=true`).
3. **Deploy:**
   ```bash
   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
   VRF_SUB_ID=<sub id> OPERATOR=<operator address> \
     forge script script/DeployGotchaVRF.s.sol --rpc-url base_sepolia --broadcast --account deployer
   ```
   Coordinator and key hash default to Chainlink's published Base / Base Sepolia values.
4. **Add the deployed contract as a consumer** on your subscription (vrf.chain.link).
5. **App secrets:** add `VRF_OPERATOR_PRIVATE_KEY` (the operator's key) to the project's server secrets in Lovable/Supabase.
6. **App config:** in Admin → Configuration, edit `vrf`: set `contract`, and for mainnet set
   `chain_id: 8453`, `rpc_url`, `explorer_url: "https://basescan.org"`.
7. **Fund the subscription** enough for expected volume (Admin → Setup shows the balance check) and record
   measured gas/VRF costs in Admin → Economics.
8. **Admin → Chainlink VRF → Publish prize pool.** The app first reconciles stock with the contract, then
   writes weights and stock on-chain and confirms them by reading the contract back.
9. Set `vrf.enabled: true` only when the setup checklist is green. (Not done automatically.)

Whenever you change prize weights, stock or active status, publish again. New draws pause while a
publication is in flight, so the odds players see are always the odds used.

## Verifying a draw

Each spin row stores `request_tx`, `vrf_request_id` and `random_word`. Anyone can call
`getSpin(bytes32 spinId)` on the contract, where `spinId` is the spin's UUID without dashes, left-padded to 32 bytes.
The call returns the Chainlink random word and the prize index the contract chose. The `SpinFulfilled`
event on the explorer shows the same values.

## Gas

The callback budget is `callbackGasBase + callbackGasPerSpin × capsules`, with a default of 100k + 100k. The worst case
measured is about 48k gas per capsule (32 prizes, all with capped stock), so the default has roughly 2× headroom. VRF bills
the gas actually used.
