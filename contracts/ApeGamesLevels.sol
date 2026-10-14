// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILevelSource {
    function levelOf(uint256 tokenId) external view returns (uint256);
}

interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// ApeGames Gotcha level tracker on ApeChain. Records NFT burns (a public burn counter) and level
/// upgrades set by the game. levelOf() returns the tracked level, or the collection's own level
/// when the game hasn't set one.
///
/// Hashlock AG-02 fix: recordBurn requires the NFT to sit at `burnSink` (or ownerOf to revert,
/// i.e. true burn / nonexistent). The operator cannot invent burns for tokens still in wallets.
contract ApeGamesLevels {
    address public owner;
    address public pendingOwner;
    address public operator;
    address public immutable collection;
    /// @notice Address players send NFTs to when burning for a free spin (config.burn_address).
    address public burnSink;

    uint256 public totalBurns;
    mapping(address => uint256) public burnsBy;
    mapping(uint256 => bool) public burned;
    mapping(uint256 => uint256) public trackedLevel;

    event OperatorChanged(address operator);
    event OwnerChanged(address owner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event BurnSinkChanged(address burnSink);
    event Burned(uint256 indexed tokenId, address indexed player, uint256 level, uint256 totalBurns);
    event LevelSet(uint256 indexed tokenId, uint256 oldLevel, uint256 newLevel);

    error TokenNotAtBurnSink(address currentOwner);
    error ZeroAddress();

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == owner, "not operator");
        _;
    }

    constructor(address _collection, address _operator, address _burnSink) {
        require(_collection != address(0) && _operator != address(0) && _burnSink != address(0), "zero");
        owner = msg.sender;
        operator = _operator;
        collection = _collection;
        burnSink = _burnSink;
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "zero");
        operator = _operator;
        emit OperatorChanged(_operator);
    }

    function setBurnSink(address _burnSink) external onlyOwner {
        require(_burnSink != address(0), "zero");
        burnSink = _burnSink;
        emit BurnSinkChanged(_burnSink);
    }

    /// @notice Two-step ownership (AG-04): nominate, then accept.
    function transferOwnership(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        pendingOwner = _owner;
        emit OwnershipTransferStarted(owner, _owner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending");
        address prev = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(prev);
        emit OwnerChanged(msg.sender);
    }

    /// @notice Record a burn only after the NFT is at burnSink (or ownerOf reverts = destroyed).
    function recordBurn(uint256 tokenId, address player, uint256 level) external onlyOperator {
        require(!burned[tokenId], "already burned");
        require(player != address(0), "zero player");
        _requireAtBurnSink(tokenId);
        burned[tokenId] = true;
        totalBurns += 1;
        burnsBy[player] += 1;
        emit Burned(tokenId, player, level, totalBurns);
    }

    function setLevel(uint256 tokenId, uint256 level) external onlyOperator {
        uint256 old = levelOf(tokenId);
        trackedLevel[tokenId] = level;
        emit LevelSet(tokenId, old, level);
    }

    function levelOf(uint256 tokenId) public view returns (uint256) {
        uint256 t = trackedLevel[tokenId];
        if (t != 0) return t;
        try ILevelSource(collection).levelOf(tokenId) returns (uint256 l) {
            return l;
        } catch {
            return 0;
        }
    }

    function _requireAtBurnSink(uint256 tokenId) internal view {
        try IERC721OwnerOf(collection).ownerOf(tokenId) returns (address currentOwner) {
            if (currentOwner != burnSink) revert TokenNotAtBurnSink(currentOwner);
        } catch {
            // ownerOf revert: token burned / nonexistent — accept as burned evidence
        }
    }
}
