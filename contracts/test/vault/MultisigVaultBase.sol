// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {MultisigVault} from "../../src/vault/MultisigVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @dev Shared setup for the vault's functional and attack suites: a funded
///      3-of-5 vault whose owners are sorted by address, with each key at the
///      same index as its owner, so signing with any ascending set of indices
///      yields correctly ordered signatures.
abstract contract MultisigVaultBase is Test {
    MultisigVault internal vault;
    MockERC20 internal token;

    uint256 internal constant OWNER_COUNT = 5;
    uint256 internal constant THRESHOLD = 3;

    address[] internal owners;
    uint256[] internal keys;

    address internal constant RECIPIENT = address(0xB0B);

    function setUp() public virtual {
        for (uint256 i; i < OWNER_COUNT; ++i) {
            (address owner, uint256 key) = makeAddrAndKey(string.concat("owner", vm.toString(i)));
            owners.push(owner);
            keys.push(key);
        }
        _sortOwners();

        vault = new MultisigVault(owners, THRESHOLD);
        vm.deal(address(vault), 10 ether);

        token = new MockERC20("Mock USD Coin", "USDC", 6);
        token.mint(address(vault), 1_000_000_000);
    }

    function _sortOwners() internal {
        for (uint256 i = 1; i < owners.length; ++i) {
            for (uint256 j = i; j > 0 && owners[j - 1] > owners[j]; --j) {
                (owners[j - 1], owners[j]) = (owners[j], owners[j - 1]);
                (keys[j - 1], keys[j]) = (keys[j], keys[j - 1]);
            }
        }
    }

    function _signWith(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(bytes32 digest, uint256[] memory indices)
        internal
        view
        returns (bytes[] memory signatures)
    {
        signatures = new bytes[](indices.length);
        for (uint256 i; i < indices.length; ++i) {
            signatures[i] = _signWith(keys[indices[i]], digest);
        }
    }

    function _indices(uint256 a, uint256 b, uint256 c)
        internal
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](3);
        (out[0], out[1], out[2]) = (a, b, c);
    }

    /// @dev A valid quorum from the three lowest owners, for the vault's current nonce.
    function _approve(address to, uint256 value, bytes memory data, uint256 deadline)
        internal
        view
        returns (bytes[] memory)
    {
        bytes32 digest = vault.hashExecute(to, value, data, vault.nonce(), deadline);
        return _sign(digest, _indices(0, 1, 2));
    }
}
