// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {GotchaVRF} from "../src/GotchaVRF.sol";

contract GotchaVRFTest is Test {
    VRFCoordinatorV2_5Mock coord;
    GotchaVRF gotcha;
    uint256 subId;
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");
    bytes32 constant KEY = keccak256("lane");

    // Seed pool (mirrors the app's default prizes): weights 600/280/100/20, inventory -/-/500/20
    uint32 constant U = type(uint32).max;

    function setUp() public {
        coord = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        subId = coord.createSubscription();
        coord.fundSubscription(subId, 1000 ether);
        gotcha = new GotchaVRF(address(coord), subId, KEY, 3, 100_000, 100_000, false, operator);
        coord.addConsumer(subId, address(gotcha));
        _setPool4(500, 20);
    }

    // ---------------------------------------------------------------- helpers
    function _setPool4(uint32 epicLeft, uint32 legLeft) internal {
        uint32[] memory w = new uint32[](4);
        uint32[] memory r = new uint32[](4);
        (w[0], w[1], w[2], w[3]) = (600, 280, 100, 20);
        (r[0], r[1], r[2], r[3]) = (U, U, epicLeft, legLeft);
        vm.prank(operator);
        gotcha.setPool(w, r);
    }

    function _ids(uint256 n, uint256 salt) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](n);
        for (uint256 i; i < n; ++i) ids[i] = keccak256(abi.encode(salt, i));
    }

    function _request(bytes32[] memory ids) internal returns (uint256) {
        vm.prank(operator);
        return gotcha.requestSpins(ids);
    }

    function _fulfill(uint256 requestId, uint256[] memory words) internal returns (bool success) {
        vm.recordLogs();
        coord.fulfillRandomWordsWithOverride(requestId, address(gotcha), words);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RandomWordsFulfilled(uint256,uint256,uint256,uint96,bool,bool,bool)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) (,,, success,) = abi.decode(logs[i].data, (uint256, uint96, bool, bool, bool));
        }
    }

    function _one(uint256 w) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = w;
    }

    // ---------------------------------------------------------------- tests

    function test_WeightedPickMatchesRoll() public {
        // total = 1000. roll 0..599 -> 0, 600..879 -> 1, 880..979 -> 2, 980..999 -> 3
        uint256[4] memory rolls = [uint256(599), 879, 979, 999];
        for (uint256 k; k < 4; ++k) {
            bytes32[] memory ids = _ids(1, 100 + k);
            uint256 req = _request(ids);
            assertTrue(_fulfill(req, _one(rolls[k] + 1000 * 77)));
            GotchaVRF.Spin memory s = gotcha.getSpin(ids[0]);
            assertEq(uint8(s.status), uint8(GotchaVRF.Status.Fulfilled));
            assertEq(s.prizeIndex, k);
            assertEq(s.randomWord, rolls[k] + 1000 * 77);
            assertEq(s.requestId, req);
        }
    }

    function test_BatchOfFiveFitsCallbackGas_WorstCasePool() public {
        // 32 prizes, all capped, so every draw scans the full pool and writes inventory.
        uint32[] memory w = new uint32[](32);
        uint32[] memory r = new uint32[](32);
        for (uint256 i; i < 32; ++i) (w[i], r[i]) = (uint32(i + 1), 1000);
        vm.prank(operator);
        gotcha.setPool(w, r);

        bytes32[] memory ids = _ids(5, 1);
        uint256 req = _request(ids);
        uint256[] memory words = new uint256[](5);
        for (uint256 i; i < 5; ++i) words[i] = uint256(keccak256(abi.encode("w", i))) | (1 << 255); // high rolls -> late indices
        assertTrue(_fulfill(req, words), "callback ran out of gas");
        for (uint256 i; i < 5; ++i) assertEq(uint8(gotcha.getSpin(ids[i]).status), uint8(GotchaVRF.Status.Fulfilled));
        assertEq(gotcha.pendingRequests(), 0);
    }

    function test_MaxBatchFitsCallbackGas() public {
        bytes32[] memory ids = _ids(10, 2);
        uint256 req = _request(ids);
        uint256[] memory words = new uint256[](10);
        for (uint256 i; i < 10; ++i) words[i] = uint256(keccak256(abi.encode(i)));
        assertTrue(_fulfill(req, words));
        for (uint256 i; i < 10; ++i) assertEq(uint8(gotcha.getSpin(ids[i]).status), uint8(GotchaVRF.Status.Fulfilled));
    }

    function test_InventoryDecrementsAndExhausts() public {
        _setPool4(0, 1); // epic sold out, one legendary left
        // roll 999 -> with epic removed total = 900; 999 % 900 = 99 -> common. Use 899 -> legendary (600+280 <= 899 < 900)
        bytes32[] memory a = _ids(1, 7);
        assertTrue(_fulfill(_request(a), _one(899)));
        assertEq(gotcha.getSpin(a[0]).prizeIndex, 3);
        GotchaVRF.Prize[] memory pool = gotcha.getPool();
        assertEq(pool[3].remaining, 0);
        assertEq(pool[0].remaining, U);
        // legendary now gone: total = 880, roll 879 -> rare
        bytes32[] memory b = _ids(1, 8);
        assertTrue(_fulfill(_request(b), _one(879)));
        assertEq(gotcha.getSpin(b[0]).prizeIndex, 1);
    }

    function test_EmptyPoolYieldsNoPrize() public {
        uint32[] memory w = new uint32[](1);
        uint32[] memory r = new uint32[](1);
        (w[0], r[0]) = (10, 1);
        vm.prank(operator);
        gotcha.setPool(w, r);
        bytes32[] memory ids = _ids(2, 9);
        assertTrue(_fulfill(_request(ids), _twoWords()));
        assertEq(gotcha.getSpin(ids[0]).prizeIndex, 0);
        assertEq(gotcha.getSpin(ids[1]).prizeIndex, gotcha.NO_PRIZE());
        assertEq(uint8(gotcha.getSpin(ids[1]).status), uint8(GotchaVRF.Status.Fulfilled));
    }

    function _twoWords() internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        (a[0], a[1]) = (5, 6);
    }

    function test_OnlyOperatorCanRequest() public {
        bytes32[] memory ids = _ids(1, 3);
        vm.prank(stranger);
        vm.expectRevert(GotchaVRF.NotOperator.selector);
        gotcha.requestSpins(ids);
    }

    function test_SpinIdsAreSingleUse() public {
        bytes32[] memory ids = _ids(1, 4);
        uint256 req = _request(ids);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GotchaVRF.SpinExists.selector, ids[0]));
        gotcha.requestSpins(ids);
        _fulfill(req, _one(1));
        // still single-use after fulfillment: no re-rolls
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GotchaVRF.SpinExists.selector, ids[0]));
        gotcha.requestSpins(ids);
    }

    function test_RejectsDuplicateAndZeroIdsInBatch() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("a");
        ids[1] = keccak256("a");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GotchaVRF.SpinExists.selector, ids[0]));
        gotcha.requestSpins(ids);
        ids[1] = bytes32(0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GotchaVRF.SpinExists.selector, bytes32(0)));
        gotcha.requestSpins(ids);
    }

    function test_BatchLimits() public {
        vm.startPrank(operator);
        vm.expectRevert(GotchaVRF.BadBatch.selector);
        gotcha.requestSpins(new bytes32[](0));
        vm.expectRevert(GotchaVRF.BadBatch.selector);
        gotcha.requestSpins(_ids(11, 5));
        vm.stopPrank();
    }

    function test_PoolLockedWhileDrawPending() public {
        uint256 req = _request(_ids(1, 6));
        uint32[] memory w = new uint32[](1);
        uint32[] memory r = new uint32[](1);
        (w[0], r[0]) = (1, U);
        vm.prank(operator);
        vm.expectRevert(GotchaVRF.PoolLocked.selector);
        gotcha.setPool(w, r);
        _fulfill(req, _one(42));
        vm.prank(operator);
        gotcha.setPool(w, r);
        assertEq(gotcha.poolVersion(), 2);
    }

    function test_StrangerCannotSetPoolOrConfig() public {
        uint32[] memory w = new uint32[](1);
        vm.prank(stranger);
        vm.expectRevert(GotchaVRF.NotOwnerOrOperator.selector);
        gotcha.setPool(w, w);
        vm.prank(stranger);
        vm.expectRevert("Only callable by owner");
        gotcha.setOperator(stranger);
        vm.prank(operator);
        vm.expectRevert("Only callable by owner");
        gotcha.setRequestsPaused(true);
    }

    function test_NoCancellationOrReRequestExists() public {
        // The production contract exposes no way to cancel or re-request a draw.
        (bool ok,) = address(gotcha).call(abi.encodeWithSignature("cancelRequest(uint256)", uint256(1)));
        assertFalse(ok, "cancelRequest must not exist");
        bytes32[] memory ids = _ids(1, 10);
        uint256 req = _request(ids);
        // Re-requesting the same spin ids is impossible while pending...
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(GotchaVRF.SpinExists.selector, ids[0]));
        gotcha.requestSpins(ids);
        // ...and the only way out of Pending is Chainlink's answer.
        assertEq(uint8(gotcha.getSpin(ids[0]).status), uint8(GotchaVRF.Status.Pending));
        assertTrue(_fulfill(req, _one(3)));
        assertEq(uint8(gotcha.getSpin(ids[0]).status), uint8(GotchaVRF.Status.Fulfilled));
    }

    function test_PauseBlocksNewRequestsButNotCallbacks() public {
        bytes32[] memory ids = _ids(2, 12);
        uint256 req = _request(ids);
        gotcha.setRequestsPaused(true); // test contract is owner
        vm.prank(operator);
        vm.expectRevert(GotchaVRF.RequestsPaused.selector);
        gotcha.requestSpins(_ids(1, 13));
        assertTrue(_fulfill(req, _twoWords()), "callbacks still settle while paused");
        assertEq(uint8(gotcha.getSpin(ids[1]).status), uint8(GotchaVRF.Status.Fulfilled));
        gotcha.setRequestsPaused(false);
        _request(_ids(1, 14));
        assertEq(gotcha.pendingRequests(), 1);
    }

    function test_UnderfundedSubscriptionRevertsRequestWithoutState() public {
        // A fresh, unfunded subscription: the coordinator mock refuses the request; nothing is recorded,
        // so the app's pre-broadcast simulation fails and the credits are refunded safely.
        uint256 dry = coord.createSubscription();
        GotchaVRF g2 = new GotchaVRF(address(coord), dry, KEY, 3, 100_000, 100_000, false, operator);
        coord.addConsumer(dry, address(g2));
        uint32[] memory w = new uint32[](1);
        uint32[] memory r = new uint32[](1);
        (w[0], r[0]) = (1, U);
        vm.prank(operator);
        g2.setPool(w, r);
        bytes32[] memory ids = _ids(1, 15);
        vm.prank(operator);
        uint256 req = g2.requestSpins(ids); // the v2.5 mock charges at fulfilment, not at request
        vm.expectRevert();
        coord.fulfillRandomWordsWithOverride(req, address(g2), _one(1));
        assertEq(uint8(g2.getSpin(ids[0]).status), uint8(GotchaVRF.Status.Pending), "stays pending (never refunded by timeout)");
    }

    function test_OnlyCoordinatorCanFulfill() public {
        uint256 req = _request(_ids(1, 11));
        vm.prank(stranger);
        vm.expectRevert();
        gotcha.rawFulfillRandomWords(req, _one(1));
    }

    function testFuzz_PickAlwaysValid(uint256 word, uint32 epicLeft, uint32 legLeft) public {
        epicLeft = uint32(bound(epicLeft, 0, 3));
        legLeft = uint32(bound(legLeft, 0, 3));
        _setPool4(epicLeft, legLeft);
        bytes32[] memory ids = _ids(1, word);
        assertTrue(_fulfill(_request(ids), _one(word)));
        uint8 idx = gotcha.getSpin(ids[0]).prizeIndex;
        assertLt(idx, 4);
        if (epicLeft == 0) assertTrue(idx != 2);
        if (legLeft == 0) assertTrue(idx != 3);
    }
}
