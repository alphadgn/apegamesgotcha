// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GotchaVRF} from "../src/GotchaVRF.sol";

/// Deploys GotchaVRF on Base or Base Sepolia with Chainlink's published VRF v2.5 settings.
///
///   VRF_SUB_ID=<your subscription id> OPERATOR=<server wallet address> \
///   forge script script/DeployGotchaVRF.s.sol --rpc-url base_sepolia --broadcast --account deployer
///
/// Optional env overrides: VRF_COORDINATOR, VRF_KEY_HASH, VRF_CONFIRMATIONS, VRF_GAS_BASE,
/// VRF_GAS_PER_SPIN, VRF_NATIVE_PAYMENT (true = pay VRF in ETH instead of LINK).
/// Values from https://docs.chain.link/vrf/v2-5/supported-networks (checked 2026-10-02).
contract DeployGotchaVRF is Script {
    function run() external returns (GotchaVRF gotcha) {
        (address defCoord, bytes32 defKey) = _defaults(block.chainid);
        address coordinator = vm.envOr("VRF_COORDINATOR", defCoord);
        bytes32 keyHash = vm.envOr("VRF_KEY_HASH", defKey);
        require(coordinator != address(0), "No VRF defaults for this chain; set VRF_COORDINATOR and VRF_KEY_HASH");

        uint256 subId = vm.envUint("VRF_SUB_ID");
        address operator = vm.envAddress("OPERATOR");
        uint16 confirmations = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32 gasBase = uint32(vm.envOr("VRF_GAS_BASE", uint256(100_000)));
        uint32 gasPerSpin = uint32(vm.envOr("VRF_GAS_PER_SPIN", uint256(100_000)));
        bool nativePayment = vm.envOr("VRF_NATIVE_PAYMENT", false);

        vm.startBroadcast();
        gotcha = new GotchaVRF(coordinator, subId, keyHash, confirmations, gasBase, gasPerSpin, nativePayment, operator);
        vm.stopBroadcast();

        console.log("GotchaVRF deployed:", address(gotcha));
        console.log("Next: add it as a consumer on subscription", subId, "at https://vrf.chain.link");
    }

    function _defaults(uint256 chainId) internal pure returns (address, bytes32) {
        if (chainId == 8453) {
            // Base mainnet — 2 gwei lane (Base gas is far below this)
            return (0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634, 0x00b81b5a830cb0a4009fbd8904de511e28631e62ce5ad231373d3cdad373ccab);
        }
        if (chainId == 84532) {
            // Base Sepolia — 30 gwei lane
            return (0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE, 0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71);
        }
        return (address(0), bytes32(0));
    }
}
