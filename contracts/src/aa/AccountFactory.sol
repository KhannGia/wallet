// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {ISenderCreator} from "account-abstraction/interfaces/ISenderCreator.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {SmartAccount} from "./SmartAccount.sol";

/// @title Deploys SmartAccounts at addresses known in advance.
/// @notice An account's address is fixed by its owner and a salt before it
///         exists, so a user can receive funds at it straight away. The
///         contract is only deployed by the user's first UserOperation, which
///         names this factory in its initCode -- and that first operation pays
///         for the deployment out of the funds already sitting there.
contract AccountFactory {
    IEntryPoint public immutable entryPoint;
    ISenderCreator public immutable senderCreator;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    error OnlySenderCreator();

    constructor(IEntryPoint entryPoint_) {
        entryPoint = entryPoint_;
        senderCreator = entryPoint_.senderCreator();
    }

    /// @notice Deploys the account, or returns it if it already exists.
    /// @dev Callable only by the EntryPoint's SenderCreator, i.e. from a
    ///      UserOperation's initCode. Anyone else deploying an account first
    ///      could not take it -- the owner is fixed by the address -- but would
    ///      make the owner's first operation fail, since the EntryPoint rejects
    ///      initCode for a sender that already has code.
    function createAccount(address owner, uint256 salt) external returns (SmartAccount account) {
        if (msg.sender != address(senderCreator)) revert OnlySenderCreator();

        address predicted = getAddress(owner, salt);
        if (predicted.code.length > 0) return SmartAccount(payable(predicted));

        account = new SmartAccount{salt: bytes32(salt)}(entryPoint, owner);
        emit AccountCreated(address(account), owner, salt);
    }

    /// @notice The address `createAccount(owner, salt)` deploys to. The owner is
    ///         part of the constructor arguments, and so of the address: the same
    ///         salt gives a different account for every owner.
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Create2.computeAddress(
            bytes32(salt),
            keccak256(
                abi.encodePacked(type(SmartAccount).creationCode, abi.encode(entryPoint, owner))
            )
        );
    }
}
