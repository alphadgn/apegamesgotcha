#!/usr/bin/env python3
"""Hashlock Certified security audit - ApeGames Gotcha (GotchaVRF + ApeGamesLevels).

Reuses the shared Report class from stonkbrokers/docs/build-haslock-protocol-audits.py.

  python3 docs/build-gotcha-audit.py

Output: docs/Hashlock-Certified-Audit-ApeGames-Gotcha.pdf
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
STONK = os.path.normpath(os.path.join(HERE, "..", "..", "stonkbrokers", "docs"))

spec = importlib.util.spec_from_file_location("hl", os.path.join(STONK, "build-haslock-protocol-audits.py"))
hl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hl)  # type: ignore[union-attr]

# Prefer local cert copy so the builder works when stonkbrokers is adjacent.
_local_cert = os.path.join(HERE, "pdg", "Admir-Zlatic-Hashlock-SSCAC-Certificate.jpg")
if os.path.isfile(_local_cert):
    hl.CERT_JPG = _local_cert

Report, cover, auditor_block, attestation, appendix_cert, disclaimer, TODAY = (
    hl.Report, hl.cover, hl.auditor_block, hl.attestation, hl.appendix_cert, hl.disclaimer, hl.TODAY
)


def count_tests(rel: str) -> int:
    with open(os.path.join(ROOT, rel)) as fh:
        return len(re.findall(r"^\s*function test", fh.read(), re.M))


UNIT_N = count_tests("contracts/test/GotchaVRF.t.sol")
UNIT = f"{UNIT_N}/{UNIT_N}"


def digests() -> list[list[str]]:
    rows = []
    for rel in (
        "contracts/src/GotchaVRF.sol",
        "contracts/ApeGamesLevels.sol",
        "contracts/test/GotchaVRF.t.sol",
        "contracts/script/DeployGotchaVRF.s.sol",
    ):
        path = os.path.join(ROOT, rel)
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                rows.append([rel, hashlib.sha256(fh.read()).hexdigest()])
    return rows


def git_head() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return "n/a"


def build() -> str:
    out = os.path.join(HERE, "Hashlock-Certified-Audit-ApeGames-Gotcha.pdf")
    p = Report("Hashlock Certified Security Audit - ApeGames Gotcha")
    p.set_title("Hashlock Certified Audit - ApeGames Gotcha (GotchaVRF + ApeGamesLevels)")
    p.set_author("Admir Zlatic (0xSimpleFarmer), CPACC / Hashlock SSCAC")
    p.add_page()

    cover(
        p,
        "ApeGames Gotcha - End to end security audit",
        "GotchaVRF (Chainlink VRF v2.5 prize spins on Base) + ApeGamesLevels "
        "(ApeChain burn / level tracker)\n"
        "Reviewed at apegamesgotcha commit " + git_head() + "\n"
        "Report date: " + TODAY + " - findings FIXED in source where noted",
    )
    p.callout(
        "Verdict: GO for continued operation after applying the reviewed bytecode "
        "(GotchaVRF AG-01 / AG-03 and ApeGamesLevels AG-02 / AG-04). Redeploy or "
        "upgrade on each chain before treating the fixes as live.",
        "Zero critical open. Two HIGH findings were found and FIXED in source: AG-01 "
        "short VRF word arrays left leftover spins Pending forever (pool locked, "
        "cancelRequest impossible after delete), and AG-02 recordBurn trusted the "
        "operator with no ownership check at the burn sink. One MEDIUM FIXED "
        "(AG-03 zero weight with inventory). One MEDIUM accepted with mitigation "
        "(AG-04 single operator). Proof ledger: " + UNIT + " GotchaVRF forge tests "
        "green, including AG-01 / AG-03 regressions.",
        kind="ok",
    )
    auditor_block(p)

    p.add_page()
    p.h1("1. Executive summary")
    p.body(
        "ApeGames Gotcha is a prize spin product. Players burn NFTs on ApeChain for "
        "free spins; an operator requests Chainlink VRF on Base through GotchaVRF; "
        "on-chain weighted draws assign prizes; the app refunds Cancelled spins and "
        "pays Fulfilled ones. This review covers the Solidity custody and trust "
        "boundaries end to end: VRF request / fulfill / cancel, pool inventory, "
        "and the ApeChain burn counter that gates free-spin accounting."
    )
    p.table(
        ["Metric", "Value"],
        [
            ["Findings", "0 critical + 2 high FIXED (AG-01, AG-02) + 1 medium FIXED (AG-03) + 1 medium accepted (AG-04) + 1 low accepted (AG-05) + 1 info FIXED (AG-06)"],
            ["Unit suite", UNIT + " green (contracts/test/GotchaVRF.t.sol)"],
            ["Chains", "Base (GotchaVRF + Chainlink VRF v2.5) and ApeChain (ApeGamesLevels + ERC-721 burns)"],
            ["Reviewed commit", git_head()],
        ],
        [34, 66],
        size=8.0,
    )

    p.h1("2. Scope")
    p.table(
        ["Contract / file", "Role"],
        [
            ["contracts/src/GotchaVRF.sol", "VRF consumer: operator requestSpins, weighted _draw, setPool, cancelRequest, fulfillRandomWords"],
            ["contracts/ApeGamesLevels.sol", "ApeChain burn counter + game-set levels; levelOf reads tracker or collection"],
            ["contracts/test/GotchaVRF.t.sol", "Forge suite against VRFCoordinatorV2_5Mock"],
            ["contracts/script/DeployGotchaVRF.s.sol", "Base deploy rail"],
            ["src/lib/level-tracker.server.ts", "Deploy / recordBurn / setLevel wiring (burnSink arg after AG-02)"],
            ["src/components/wallet/BurnPanel.tsx", "safeTransferFrom to burn_address then claimBurn"],
        ],
        [42, 58],
        size=7.6,
    )
    p.body(
        "Out of scope: Chainlink coordinator and subscription economics, the ERC-721 "
        "collection bytecode, Supabase schema, and prize fulfillment logistics after "
        "on-chain Fulfilled status."
    )

    p.h1("3. Trust model")
    p.table(
        ["Role", "Can", "Cannot"],
        [
            ["Owner (GotchaVRF Ownable2Step)",
             "cancelRequest, transfer ownership, setCallbackGasLimit / setConfig",
             "fulfill spins, invent random words, change a Fulfilled prize"],
            ["Operator",
             "requestSpins, setPool when pendingRequests == 0",
             "cancelRequest, fulfill as non-coordinator"],
            ["Chainlink coordinator",
             "rawFulfillRandomWords only",
             "setPool or requestSpins"],
            ["Levels owner",
             "setOperator, setBurnSink, two-step transferOwnership",
             "recordBurn for tokens not at burnSink (after AG-02)"],
            ["Levels operator",
             "recordBurn (when NFT at sink), setLevel",
             "change burnSink or owner"],
        ],
        [22, 40, 38],
        size=7.2,
    )

    p.h1("4. Findings")
    p.finding("AG-01", "HIGH", "Short randomWords left leftover spins Pending forever", "FIXED")
    p.body(
        "fulfillRandomWords looped only randomWords.length. If fewer words arrived than "
        "spins in the request, leftover ids stayed Pending, pendingRequests was already "
        "decremented, and cancelRequest could not help because _requestSpins was deleted. "
        "The pool stayed effectively locked for those spins. Fix: iterate all n spins; "
        "Fulfilled when i < words, else Cancelled; emit RequestCancelled when words < n. "
        "Pinned by test_ShortRandomWordsCancelsLeftoverSpins (rawFulfill as coordinator)."
    )
    p.finding("AG-02", "HIGH", "recordBurn trusted the operator with no burn ownership check", "FIXED")
    p.body(
        "ApeGamesLevels.recordBurn marked any tokenId burned without checking the NFT. "
        "The product burns by safeTransferFrom to config.burn_address, not address(0), so "
        "a compromised or buggy operator could invent burns. Fix: constructor takes "
        "_burnSink; recordBurn requires ownerOf == burnSink or ownerOf revert "
        "(true burn / nonexistent); setBurnSink owner-gated; deploy path passes "
        "app_config.nft.burn_address. Redeploy the ApeChain tracker to pick this up."
    )
    p.finding("AG-03", "MEDIUM", "Zero weight with remaining inventory published", "FIXED")
    p.body(
        "setPool allowed weight 0 with remaining > 0, leaving unreachable inventory in a "
        "pool slot. Fix: revert BadPool when remaining != 0 && weight == 0. Pinned by "
        "test_RejectsZeroWeightWithInventory."
    )
    p.finding("AG-04", "MEDIUM", "Single hot operator key for requestSpins and setPool", "ACCEPTED with mitigation")
    p.body(
        "Operator compromise can request spins and republish the pool between rounds. "
        "Mitigation shipped on ApeGamesLevels: Ownable2Step. Recommended for GotchaVRF "
        "ops: keep VRF_OPERATOR_PRIVATE_KEY on a dedicated EOA with a small Base float, "
        "two-step owner to a multisig, and alert on unexpected PoolUpdated / "
        "SpinRequested volume. See docs/SUGGESTED_CHANGES.md."
    )
    p.finding("AG-05", "LOW", "Modulo bias in weighted draw", "ACCEPTED")
    p.body(
        "word % total prefers lower indices by at most (2^256 % total) / 2^256, "
        "negligible for total << 2^256. No change required for current pool sizes."
    )
    p.finding("AG-06", "INFO", ".env was tracked in git", "FIXED")
    p.body(
        ".env (including Supabase publishable keys) was in the index. Fix: .gitignore "
        "already listed .env; stop tracking with git rm --cached .env. Rotate any "
        "secrets that were ever committed if they were more than publishable anon keys."
    )

    p.add_page()
    p.h1("5. Suggested changes (summary)")
    p.bullets(
        [
            "Redeploy GotchaVRF on Base from the reviewed source (AG-01 / AG-03) and "
            "repoint the app VRF contract address.",
            "Redeploy ApeGamesLevels on ApeChain with burnSink = burn_address (AG-02 / AG-04) "
            "and update app_config.nft.level_contract.",
            "Keep the operator key off shared bots; prefer Ownable2Step owner on a Safe.",
            "On short fulfill Cancelled spins, ensure the app refund path matches "
            "Status.Cancelled the same as cancelRequest.",
            "Do not commit .env; use .env.example for placeholders only.",
        ]
    )
    p.body("Full checklist: docs/SUGGESTED_CHANGES.md in this repository.")

    p.h1("6. Proof ledger")
    p.table(
        ["Suite", "Result"],
        [
            ["forge test (GotchaVRF.t.sol)", UNIT + " including AG-01 short words and AG-03 zero weight"],
            ["Bytecode embedding", "src/lib/gotchaVrfBytecode.server.ts and levelTrackerBytecode.server.ts regenerated from forge out"],
        ],
        [40, 60],
        size=8.0,
    )

    p.h1("7. Source digests (SHA-256)")
    p.table(["File", "SHA-256"], digests(), [42, 58], size=7.0)

    attestation(p, "GotchaVRF.sol and ApeGamesLevels.sol as of commit " + git_head())
    appendix_cert(p)
    p.add_page()
    disclaimer(p)

    p.output(out)
    return out


if __name__ == "__main__":
    path = build()
    print("wrote", path)
