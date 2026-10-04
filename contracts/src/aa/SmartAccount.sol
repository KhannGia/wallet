// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title A user's own ERC-4337 account.
/// @notice A contract that is a wallet. The user signs UserOperations; a bundler
///         submits them to the EntryPoint, which asks this account whether the
///         signature is good before letting it act. Nobody else -- the platform
///         included -- can move what it holds.
/// @dev Written against EntryPoint v0.8, where the userOpHash is an EIP-712
///      digest over the operation, the EntryPoint and the chain. That binding
///      is what makes a signature worthless on any other chain, EntryPoint or
///      account; the owner signs the digest as it is, with no message prefix.
///
///      Deliberately not upgradeable. An upgrade path is a second way to take
///      the account over, and the owner can always move funds to a new one.
contract SmartAccount is IAccount {
    /// @dev ERC-4337's verdicts. A bad signature is reported, not reverted, so
    ///      a bundler simulating the operation -- or estimating its gas with a
    ///      placeholder signature -- gets an answer rather than an error.
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    IEntryPoint public immutable entryPoint;
    address public owner;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error OnlyEntryPoint();
    error InvalidOwner();
    error CallFailed(uint256 index, bytes returndata);

    constructor(IEntryPoint entryPoint_, address owner_) {
        // A malformed signature recovers to the zero address. With the zero
        // address as owner, a single missed error check would hand the account
        // to anyone who sends garbage.
        if (owner_ == address(0)) revert InvalidOwner();
        entryPoint = entryPoint_;
        owner = owner_;
    }

    receive() external payable {}

    /// @dev Only the EntryPoint can make the account act, and only after it has
    ///      validated a UserOperation. The account may also call itself, which
    ///      is how later phases will change its own settings through a signed
    ///      operation.
    modifier onlyEntryPointOrSelf() {
        if (msg.sender != address(entryPoint) && msg.sender != address(this)) {
            revert OnlyEntryPoint();
        }
        _;
    }

    /// @inheritdoc IAccount
    /// @dev Must not revert over a bad signature, and must pay what it owes the
    ///      EntryPoint for gas even when it has no deposit there. Nonces are the
    ///      EntryPoint's job: it rejects a replayed operation before asking.
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();

        // tryRecover, not recover: a malformed or malleable signature must come
        // back as a failure verdict rather than a revert.
        (address signer, ECDSA.RecoverError recoverError,) =
            ECDSA.tryRecover(userOpHash, userOp.signature);
        validationData = (recoverError == ECDSA.RecoverError.NoError && signer == owner)
            ? SIG_VALIDATION_SUCCESS
            : SIG_VALIDATION_FAILED;

        if (missingAccountFunds != 0) {
            // The EntryPoint verifies it was paid; a failed transfer here only
            // means the operation is rejected there.
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (paid);
        }
    }

    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyEntryPointOrSelf
    {
        _call(0, target, value, data);
    }

    /// @notice Several calls in one operation, all or nothing -- an approve and
    ///         the transfer it allows, say.
    function executeBatch(Call[] calldata calls) external onlyEntryPointOrSelf {
        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(uint256 index, address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory returndata) = target.call{value: value}(data);
        if (!ok) revert CallFailed(index, returndata);
    }
}
