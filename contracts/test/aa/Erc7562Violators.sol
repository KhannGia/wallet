// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Accounts that break ERC-7562 on purpose, each in one way, otherwise
///      valid. A bundler in safe mode must refuse their operations: if it
///      accepted them, its "safe mode" would not be checking anything, and a
///      passing compliance test for SmartAccount would mean nothing.
abstract contract ViolatingAccount is IAccount {
    address internal immutable entryPoint;
    address internal immutable owner;

    constructor(address entryPoint_, address owner_) {
        entryPoint = entryPoint_;
        owner = owner_;
    }

    receive() external payable {}

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256) {
        require(msg.sender == entryPoint, "not entry point");
        _violate();
        (address signer,,) = ECDSA.tryRecover(userOpHash, userOp.signature);
        if (missingAccountFunds != 0) {
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (paid);
        }
        return signer == owner ? 0 : 1;
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "not entry point");
        (bool ok,) = target.call{value: value}(data);
        require(ok, "call failed");
    }

    function _violate() internal view virtual;
}

/// @dev Reads the clock while validating. TIMESTAMP is banned: its value at
///      simulation is not its value when the bundle lands.
contract ClockReadingAccount is ViolatingAccount {
    uint256 public seen;

    constructor(address entryPoint_, address owner_) ViolatingAccount(entryPoint_, owner_) {}

    function _violate() internal view override {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp != 0, "clock");
    }
}

/// @dev Reads another contract's storage that is not associated with the
///      sender: someone else's token balance. Any transaction moving that
///      balance could invalidate every operation in the mempool at once.
contract ForeignStorageAccount is ViolatingAccount {
    IERC20 internal immutable token;

    constructor(address entryPoint_, address owner_, IERC20 token_)
        ViolatingAccount(entryPoint_, owner_)
    {
        token = token_;
    }

    function _violate() internal view override {
        require(token.balanceOf(address(0xdead)) != type(uint256).max, "balance");
    }
}
