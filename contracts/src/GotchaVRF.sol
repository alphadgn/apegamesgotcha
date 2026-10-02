// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/// @title GotchaVRF — on-chain prize draws for the ApeGames Gotcha machine
/// @notice Every capsule is drawn by Chainlink VRF v2.5 and the prize is picked *inside this contract*
///         from the published prize pool. The app server can request draws (it holds the off-chain spin
///         credits) but can never see, choose or re-roll the random number.
/// @dev Roles:
///      - owner (ConfirmedOwner, from VRFConsumerBaseV2Plus): VRF config, operator, cancellations.
///      - operator (the app's server wallet): requests draws, publishes the prize pool.
///      The pool cannot change while any draw is pending, so odds can't be swapped mid-draw.
contract GotchaVRF is VRFConsumerBaseV2Plus {
    // ---------------------------------------------------------------- types
    enum Status {
        None,
        Pending,
        Fulfilled,
        Cancelled
    }

    struct Prize {
        uint32 weight; // relative odds
        uint32 remaining; // UNLIMITED = no inventory cap
    }

    struct Spin {
        Status status;
        uint8 prizeIndex; // NO_PRIZE if the pool was empty at fulfillment
        uint64 requestedAt;
        uint256 requestId;
        uint256 randomWord;
    }

    // ---------------------------------------------------------------- constants
    uint32 public constant UNLIMITED = type(uint32).max;
    uint8 public constant NO_PRIZE = type(uint8).max;
    uint256 public constant MAX_PRIZES = 32;
    uint256 public constant MAX_BATCH = 10;

    // ---------------------------------------------------------------- storage
    Prize[] internal _pool;
    uint256 public poolVersion;

    mapping(bytes32 spinId => Spin) internal _spins;
    mapping(uint256 requestId => bytes32[] spinIds) internal _requestSpins;
    uint256 public pendingRequests;

    address public operator;

    uint256 public subscriptionId;
    bytes32 public keyHash;
    uint16 public requestConfirmations;
    uint32 public callbackGasBase;
    uint32 public callbackGasPerSpin;
    bool public nativePayment;

    // ---------------------------------------------------------------- events
    event SpinRequested(bytes32 indexed spinId, uint256 indexed requestId);
    event SpinFulfilled(bytes32 indexed spinId, uint256 indexed requestId, uint256 randomWord, uint8 prizeIndex);
    event RequestCancelled(uint256 indexed requestId);
    event PoolUpdated(uint256 indexed version, uint32[] weights, uint32[] remaining);
    event OperatorUpdated(address operator);
    event VrfConfigUpdated(uint256 subscriptionId, bytes32 keyHash, uint16 confirmations, uint32 gasBase, uint32 gasPerSpin, bool nativePayment);

    // ---------------------------------------------------------------- errors
    error NotOperator();
    error NotOwnerOrOperator();
    error BadBatch();
    error SpinExists(bytes32 spinId);
    error EmptyPool();
    error PoolLocked();
    error BadPool();
    error UnknownRequest();

    constructor(
        address coordinator,
        uint256 subId,
        bytes32 keyHash_,
        uint16 confirmations,
        uint32 gasBase,
        uint32 gasPerSpin,
        bool nativePayment_,
        address operator_
    ) VRFConsumerBaseV2Plus(coordinator) {
        _setVrfConfig(subId, keyHash_, confirmations, gasBase, gasPerSpin, nativePayment_);
        operator = operator_;
        emit OperatorUpdated(operator_);
    }

    // ---------------------------------------------------------------- draws

    /// @notice Request one VRF draw covering `spinIds.length` capsules (one random word each).
    /// @param spinIds Unique ids from the app database (bytes32-encoded UUIDs). Each can be used once.
    function requestSpins(bytes32[] calldata spinIds) external returns (uint256 requestId) {
        if (msg.sender != operator) revert NotOperator();
        uint256 n = spinIds.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatch();
        if (_pool.length == 0) revert EmptyPool();
        for (uint256 i; i < n; ++i) {
            bytes32 id = spinIds[i];
            if (id == bytes32(0) || _spins[id].status != Status.None) revert SpinExists(id);
            for (uint256 j; j < i; ++j) if (spinIds[j] == id) revert SpinExists(id);
        }

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasBase + callbackGasPerSpin * uint32(n),
                numWords: uint32(n),
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );

        bytes32[] storage list = _requestSpins[requestId];
        for (uint256 i; i < n; ++i) {
            bytes32 id = spinIds[i];
            _spins[id] = Spin({status: Status.Pending, prizeIndex: 0, requestedAt: uint64(block.timestamp), requestId: requestId, randomWord: 0});
            list.push(id);
            emit SpinRequested(id, requestId);
        }
        ++pendingRequests;
    }

    /// @dev Chainlink callback. Must never revert.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        bytes32[] storage ids = _requestSpins[requestId];
        uint256 n = ids.length;
        if (n == 0) return; // cancelled or unknown
        --pendingRequests;
        for (uint256 i; i < n && i < randomWords.length; ++i) {
            bytes32 id = ids[i];
            Spin storage s = _spins[id];
            if (s.status != Status.Pending) continue;
            uint256 word = randomWords[i];
            uint8 idx = _draw(word);
            s.status = Status.Fulfilled;
            s.randomWord = word;
            s.prizeIndex = idx;
            emit SpinFulfilled(id, requestId, word, idx);
        }
        delete _requestSpins[requestId];
    }

    /// @dev Weighted pick over prizes that still have inventory. Decrements capped inventory.
    function _draw(uint256 word) internal returns (uint8) {
        uint256 len = _pool.length;
        uint256 total;
        for (uint256 i; i < len; ++i) {
            Prize memory p = _pool[i];
            if (p.remaining != 0) total += p.weight;
        }
        if (total == 0) return NO_PRIZE;
        uint256 roll = word % total;
        for (uint256 i; i < len; ++i) {
            Prize memory p = _pool[i];
            if (p.remaining == 0) continue;
            if (roll < p.weight) {
                if (p.remaining != UNLIMITED) _pool[i].remaining = p.remaining - 1;
                return uint8(i);
            }
            roll -= p.weight;
        }
        return NO_PRIZE; // unreachable
    }

    // ---------------------------------------------------------------- admin

    /// @notice Publish the prize pool. Index i must match `prizes.onchain_index = i` in the app DB.
    function setPool(uint32[] calldata weights, uint32[] calldata remaining) external {
        if (msg.sender != operator && msg.sender != owner()) revert NotOwnerOrOperator();
        if (pendingRequests != 0) revert PoolLocked();
        uint256 n = weights.length;
        if (n == 0 || n > MAX_PRIZES || n != remaining.length) revert BadPool();
        delete _pool;
        for (uint256 i; i < n; ++i) _pool.push(Prize({weight: weights[i], remaining: remaining[i]}));
        emit PoolUpdated(++poolVersion, weights, remaining);
    }

    /// @notice Escape hatch if a request is never fulfilled (e.g. subscription ran dry).
    function cancelRequest(uint256 requestId) external onlyOwner {
        bytes32[] storage ids = _requestSpins[requestId];
        uint256 n = ids.length;
        if (n == 0) revert UnknownRequest();
        for (uint256 i; i < n; ++i) _spins[ids[i]].status = Status.Cancelled;
        delete _requestSpins[requestId];
        --pendingRequests;
        emit RequestCancelled(requestId);
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorUpdated(operator_);
    }

    function setVrfConfig(uint256 subId, bytes32 keyHash_, uint16 confirmations, uint32 gasBase, uint32 gasPerSpin, bool nativePayment_)
        external
        onlyOwner
    {
        _setVrfConfig(subId, keyHash_, confirmations, gasBase, gasPerSpin, nativePayment_);
    }

    function _setVrfConfig(uint256 subId, bytes32 keyHash_, uint16 confirmations, uint32 gasBase, uint32 gasPerSpin, bool nativePayment_) internal {
        subscriptionId = subId;
        keyHash = keyHash_;
        requestConfirmations = confirmations;
        callbackGasBase = gasBase;
        callbackGasPerSpin = gasPerSpin;
        nativePayment = nativePayment_;
        emit VrfConfigUpdated(subId, keyHash_, confirmations, gasBase, gasPerSpin, nativePayment_);
    }

    // ---------------------------------------------------------------- views

    function getSpin(bytes32 spinId) external view returns (Spin memory) {
        return _spins[spinId];
    }

    function getSpins(bytes32[] calldata spinIds) external view returns (Spin[] memory out) {
        out = new Spin[](spinIds.length);
        for (uint256 i; i < spinIds.length; ++i) out[i] = _spins[spinIds[i]];
    }

    function getPool() external view returns (Prize[] memory) {
        return _pool;
    }

    function getRequestSpins(uint256 requestId) external view returns (bytes32[] memory) {
        return _requestSpins[requestId];
    }
}
