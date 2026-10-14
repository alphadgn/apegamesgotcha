// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILevelSource { function levelOf(uint256 tokenId) external view returns (uint256); }

/// ApeGames Gotcha level tracker on ApeChain. Records NFT burns (a public burn counter) and level
/// upgrades set by the game. levelOf() returns the tracked level, or the collection's own level
/// when the game hasn't set one.
contract ApeGamesLevels {
    address public owner;
    address public operator;
    address public immutable collection;

    uint256 public totalBurns;
    mapping(address => uint256) public burnsBy;
    mapping(uint256 => bool) public burned;
    mapping(uint256 => uint256) public trackedLevel;

    event OperatorChanged(address operator);
    event OwnerChanged(address owner);
    event Burned(uint256 indexed tokenId, address indexed player, uint256 level, uint256 totalBurns);
    event LevelSet(uint256 indexed tokenId, uint256 oldLevel, uint256 newLevel);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyOperator() { require(msg.sender == operator || msg.sender == owner, "not operator"); _; }

    constructor(address _collection, address _operator) {
        owner = msg.sender;
        operator = _operator;
        collection = _collection;
    }

    function setOperator(address _operator) external onlyOwner { operator = _operator; emit OperatorChanged(_operator); }
    function transferOwnership(address _owner) external onlyOwner { require(_owner != address(0), "zero"); owner = _owner; emit OwnerChanged(_owner); }

    function recordBurn(uint256 tokenId, address player, uint256 level) external onlyOperator {
        require(!burned[tokenId], "already burned");
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
        try ILevelSource(collection).levelOf(tokenId) returns (uint256 l) { return l; } catch { return 0; }
    }
}
