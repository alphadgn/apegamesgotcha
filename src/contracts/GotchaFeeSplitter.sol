// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GotchaFeeSplitter — splits ApeGames Gotcha fees (native APE on ApeChain) into 8 buckets
/// @notice Every APE that arrives is split by fixed percentages the moment it lands.
///         - Direct buckets (Team, Operations): anyone can push the balance to the recipient at any time.
///         - Accrue buckets (stock, StonkBroker, BAYC, MAYC...): APE is locked until the bucket reaches
///           its target (the current floor price in APE), then the keeper releases exactly that target
///           to the bucket's fixed recipient (the buyer/bridge wallet), which makes the purchase.
/// @dev The keeper can set targets and trigger releases but can only ever send funds to the
///      recipient the owner configured, never to itself. Percentages are fixed forever at deploy.
contract GotchaFeeSplitter {
    // ---------------------------------------------------------------- types
    enum Mode {
        Direct,
        Accrue
    }

    struct Bucket {
        string name;
        address recipient;
        uint16 bps; // share of every fee, out of 10_000
        Mode mode;
        uint256 balance; // APE (wei) currently held for this bucket
        uint256 target; // Accrue only: amount to release per buy (0 = release whole balance)
    }

    // ---------------------------------------------------------------- constants
    uint256 public constant BPS = 10_000;
    uint256 public constant BUCKETS = 8;

    uint256 public constant TEAM = 0;
    uint256 public constant OPERATIONS = 1;
    uint256 public constant STOCK_TOKENS = 2;
    uint256 public constant STOCK_CERTIFICATES = 3;
    uint256 public constant STONKBROKER_NFT = 4;
    uint256 public constant STONKBROKER_BURN = 5;
    uint256 public constant BAYC = 6;
    uint256 public constant MAYC = 7;

    // ---------------------------------------------------------------- storage
    Bucket[] internal _buckets;
    uint256 public totalTracked; // sum of all bucket balances
    uint256 public totalReceived; // lifetime fees split

    address public owner;
    address public pendingOwner;
    address public keeper;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events
    event FeesSplit(address indexed from, uint256 amount);
    event PaidOut(uint256 indexed bucket, address indexed to, uint256 amount);
    event Released(uint256 indexed bucket, address indexed to, uint256 amount, uint256 target);
    event TargetSet(uint256 indexed bucket, uint256 target);
    event RecipientSet(uint256 indexed bucket, address recipient);
    event KeeperSet(address keeper);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
    error BadBucket();
    error WrongMode();
    error NothingToSend();
    error BelowTarget(uint256 balance, uint256 target);
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param owner_ Admin (sets recipients and keeper).
    /// @param keeper_ Bot wallet that updates floor targets and triggers buys.
    /// @param recipients Where each bucket's APE goes, in bucket order:
    ///        [team, operations, stockTokens, stockCertificates, stonkbrokerNft, stonkbrokerBurn, bayc, mayc]
    constructor(address owner_, address keeper_, address[8] memory recipients) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        keeper = keeper_;
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);

        _add("Team", recipients[0], 4000, Mode.Direct);
        _add("Operations", recipients[1], 1000, Mode.Direct);
        _add("Stock tokens", recipients[2], 500, Mode.Accrue);
        _add("Stock certificates", recipients[3], 500, Mode.Accrue);
        _add("StonkBroker NFT for gotcha", recipients[4], 1000, Mode.Accrue);
        _add("Buy & burn $STONKBROKER", recipients[5], 1000, Mode.Accrue);
        _add("BAYC for gotcha", recipients[6], 1000, Mode.Accrue);
        _add("MAYC for gotcha", recipients[7], 1000, Mode.Accrue);
    }

    function _add(string memory name, address recipient, uint16 bps, Mode mode) private {
        if (recipient == address(0)) revert ZeroAddress();
        _buckets.push(Bucket({name: name, recipient: recipient, bps: bps, mode: mode, balance: 0, target: 0}));
        emit RecipientSet(_buckets.length - 1, recipient);
    }

    // ---------------------------------------------------------------- incoming fees

    /// @notice Send APE here and it is split immediately.
    receive() external payable {
        _split(msg.value);
    }

    /// @notice Same as sending APE directly, for callers that prefer a function call.
    function deposit() external payable {
        _split(msg.value);
    }

    /// @notice Splits any APE that reached the contract without going through receive()
    ///         (e.g. chain yield or forced sends). Anyone can call.
    function syncSurplus() external {
        uint256 surplus = address(this).balance - totalTracked;
        if (surplus == 0) revert NothingToSend();
        _split(surplus);
    }

    function _split(uint256 amount) private {
        if (amount == 0) return;
        uint256 distributed;
        for (uint256 i; i < BUCKETS; ++i) {
            uint256 share = (amount * _buckets[i].bps) / BPS;
            _buckets[i].balance += share;
            distributed += share;
        }
        // rounding dust goes to Team
        _buckets[TEAM].balance += amount - distributed;
        totalTracked += amount;
        totalReceived += amount;
        emit FeesSplit(msg.sender, amount);
    }

    // ---------------------------------------------------------------- direct payouts

    /// @notice Push a Direct bucket's full balance to its recipient. Anyone can call.
    function payout(uint256 i) public nonReentrant {
        Bucket storage b = _bucket(i);
        if (b.mode != Mode.Direct) revert WrongMode();
        uint256 amount = b.balance;
        if (amount == 0) revert NothingToSend();
        b.balance = 0;
        totalTracked -= amount;
        _send(b.recipient, amount);
        emit PaidOut(i, b.recipient, amount);
    }

    /// @notice Pay out Team and Operations in one call (skips empty ones). Anyone can call.
    function payoutAll() external {
        if (_buckets[TEAM].balance != 0) payout(TEAM);
        if (_buckets[OPERATIONS].balance != 0) payout(OPERATIONS);
    }

    // ---------------------------------------------------------------- floor buys

    /// @notice Keeper posts the current floor (in APE wei, include a buffer for bridge + gas) for a bucket.
    function setTarget(uint256 i, uint256 target) external onlyKeeper {
        Bucket storage b = _bucket(i);
        if (b.mode != Mode.Accrue) revert WrongMode();
        b.target = target;
        emit TargetSet(i, target);
    }

    /// @notice Keeper posts several targets at once.
    function setTargets(uint256[] calldata ids, uint256[] calldata targets) external onlyKeeper {
        if (ids.length != targets.length) revert BadBucket();
        for (uint256 k; k < ids.length; ++k) {
            Bucket storage b = _bucket(ids[k]);
            if (b.mode != Mode.Accrue) revert WrongMode();
            b.target = targets[k];
            emit TargetSet(ids[k], targets[k]);
        }
    }

    /// @notice Once a bucket holds at least its target, send exactly the target to the bucket's
    ///         buyer wallet so it can make the purchase. Leftover keeps accruing for the next one.
    ///         If target is 0, the whole balance is released (useful for the stock buckets).
    function release(uint256 i) external onlyKeeper nonReentrant {
        Bucket storage b = _bucket(i);
        if (b.mode != Mode.Accrue) revert WrongMode();
        uint256 amount = b.target == 0 ? b.balance : b.target;
        if (amount == 0) revert NothingToSend();
        if (b.balance < amount) revert BelowTarget(b.balance, amount);
        b.balance -= amount;
        totalTracked -= amount;
        _send(b.recipient, amount);
        emit Released(i, b.recipient, amount, b.target);
    }

    // ---------------------------------------------------------------- admin

    function setRecipient(uint256 i, address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        _bucket(i).recipient = recipient;
        emit RecipientSet(i, recipient);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- views

    function getBucket(uint256 i) external view returns (Bucket memory) {
        return _bucket(i);
    }

    function getBuckets() external view returns (Bucket[] memory) {
        return _buckets;
    }

    /// @notice True when an Accrue bucket can be released (has reached its floor target).
    function readyToBuy(uint256 i) external view returns (bool) {
        Bucket storage b = _bucket(i);
        if (b.mode != Mode.Accrue) return false;
        uint256 amount = b.target == 0 ? b.balance : b.target;
        return amount != 0 && b.balance >= amount;
    }

    // ---------------------------------------------------------------- internal

    function _bucket(uint256 i) private view returns (Bucket storage) {
        if (i >= BUCKETS) revert BadBucket();
        return _buckets[i];
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
