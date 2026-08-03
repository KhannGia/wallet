// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Placeholder that exists only to prove the Foundry toolchain compiles,
///         tests and deploys end to end. Delete it in P7 when MultisigVault
///         becomes the first real contract.
contract Ping {
    event Pinged(address indexed caller, uint256 count);

    uint256 public count;

    function ping() external returns (uint256) {
        count += 1;
        emit Pinged(msg.sender, count);
        return count;
    }
}
