// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal NON-enumerable ERC-721 used by the app's snapshot/burn integration tests (no tokenOfOwnerByIndex).
contract MockNonEnumerableNFT {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    mapping(uint256 => address) internal _owner;
    mapping(address => uint256) public balanceOf;

    function ownerOf(uint256 id) external view returns (address o) {
        o = _owner[id];
        require(o != address(0), "ERC721: invalid token ID");
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "";
    }

    function mintBatch(address to, uint256 fromId, uint256 count) external {
        for (uint256 i; i < count; ++i) {
            uint256 id = fromId + i;
            require(_owner[id] == address(0), "minted");
            _owner[id] = to;
            emit Transfer(address(0), to, id);
        }
        balanceOf[to] += count;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(_owner[id] == from && msg.sender == from, "not owner");
        _owner[id] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, id);
    }

    /// Burn several tokens to `to` in one transaction (multiple Transfer logs).
    function transferMany(address to, uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) transferFrom(msg.sender, to, ids[i]);
    }
}

/// Smart-contract wallet that accepts signatures from its EOA owner (ERC-1271).
contract MockERC1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
