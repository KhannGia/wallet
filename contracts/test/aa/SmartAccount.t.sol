// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {AccountFactory} from "../../src/aa/AccountFactory.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SmartAccountBase} from "./SmartAccountBase.sol";

contract SmartAccountTest is SmartAccountBase {
    // --- counterfactual deployment --------------------------------------------

    function test_ReceivesFundsBeforeItExists() public {
        address predicted = factory.getAddress(owner, 0);
        assertEq(predicted.code.length, 0);

        // Funds arrive at an address with no code behind it yet.
        vm.deal(predicted, 1 ether);
        token.mint(predicted, 500_000_000);

        vm.expectEmit(address(factory));
        emit AccountFactory.AccountCreated(predicted, owner, 0);
        SmartAccount account = _deployAndCall(
            0, address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, 200_000_000))
        );

        // The first operation deployed the account exactly where predicted,
        // then spent from it.
        assertEq(address(account), predicted);
        assertGt(predicted.code.length, 0);
        assertEq(account.owner(), owner);
        assertEq(address(account.entryPoint()), address(entryPoint));
        assertEq(token.balanceOf(RECIPIENT), 200_000_000);
    }

    function test_PaysForItsOwnGas() public {
        address predicted = factory.getAddress(owner, 0);
        vm.deal(predicted, 1 ether);

        _deployAndCall(0, RECIPIENT, 0.1 ether, "");

        // The account paid the bundler back out of its own balance. It prefunds
        // the operation's maximum cost; what the operation did not use stays
        // with the EntryPoint as the account's deposit, and pays for the next
        // one -- it does not come back to the account's balance.
        assertEq(RECIPIENT.balance, 0.1 ether);
        assertGt(bundler.balance, 0);
        assertGt(entryPoint.balanceOf(predicted), 0);
        assertEq(
            predicted.balance + entryPoint.balanceOf(predicted) + bundler.balance
                + RECIPIENT.balance,
            1 ether,
            "every wei is accounted for"
        );
    }

    function test_LaterOperationsNeedNoInitCode() public {
        address predicted = factory.getAddress(owner, 0);
        vm.deal(predicted, 1 ether);
        _deployAndCall(0, RECIPIENT, 1 wei, "");

        assertEq(entryPoint.getNonce(predicted, 0), 1);
        _submit(_signWith(ownerKey, _op(predicted, "", _execute(RECIPIENT, 1 wei, ""))));

        assertEq(RECIPIENT.balance, 2 wei);
        assertEq(entryPoint.getNonce(predicted, 0), 2);
    }

    function test_AddressDependsOnOwnerAndSalt() public {
        address other = makeAddr("other");
        assertTrue(factory.getAddress(owner, 0) != factory.getAddress(other, 0));
        assertTrue(factory.getAddress(owner, 0) != factory.getAddress(owner, 1));
    }

    function test_FactoryReturnsAnExistingAccount() public {
        vm.startPrank(address(factory.senderCreator()));
        SmartAccount first = factory.createAccount(owner, 7);
        SmartAccount second = factory.createAccount(owner, 7);
        vm.stopPrank();

        assertEq(address(first), address(second));
        assertEq(address(first), factory.getAddress(owner, 7));
    }

    // --- execution ------------------------------------------------------------

    function test_ExecutesABatch() public {
        address predicted = factory.getAddress(owner, 0);
        vm.deal(predicted, 1 ether);
        token.mint(predicted, 100);
        _deployAndCall(0, RECIPIENT, 0, "");

        SmartAccount.Call[] memory calls = new SmartAccount.Call[](2);
        calls[0] = SmartAccount.Call(
            address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, 60))
        );
        calls[1] = SmartAccount.Call(RECIPIENT, 0.2 ether, "");
        bytes memory callData = abi.encodeCall(SmartAccount.executeBatch, (calls));

        _submit(_signWith(ownerKey, _op(predicted, "", callData)));

        assertEq(token.balanceOf(RECIPIENT), 60);
        assertEq(RECIPIENT.balance, 0.2 ether);
    }

    function test_BatchIsAllOrNothing() public {
        address predicted = factory.getAddress(owner, 0);
        vm.deal(predicted, 1 ether);
        token.mint(predicted, 100);
        _deployAndCall(0, RECIPIENT, 0, "");

        SmartAccount.Call[] memory calls = new SmartAccount.Call[](2);
        calls[0] = SmartAccount.Call(
            address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, 60))
        );
        // More tokens than the account holds: the second call reverts.
        calls[1] = SmartAccount.Call(
            address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, 1_000))
        );
        PackedUserOperation memory op = _signWith(
            ownerKey, _op(predicted, "", abi.encodeCall(SmartAccount.executeBatch, (calls)))
        );

        // The EntryPoint still charges for the attempt, and reports it failed.
        vm.expectEmit(true, true, true, false, address(entryPoint));
        emit IEntryPoint.UserOperationEvent(
            entryPoint.getUserOpHash(op), predicted, address(0), 1, false, 0, 0
        );
        _submit(op);

        assertEq(token.balanceOf(RECIPIENT), 0, "the first transfer was rolled back too");
    }

    function test_CanCallItself() public {
        address predicted = factory.getAddress(owner, 0);
        vm.deal(predicted, 1 ether);
        _deployAndCall(0, RECIPIENT, 0, "");

        // The account calling its own execute: how later phases will let a
        // signed operation change the account's settings.
        bytes memory inner = _execute(RECIPIENT, 1 wei, "");
        _submit(_signWith(ownerKey, _op(predicted, "", _execute(predicted, 0, inner))));

        assertEq(RECIPIENT.balance, 1 wei);
    }

    // --- validation verdicts --------------------------------------------------

    function test_ReportsABadSignatureInsteadOfReverting() public {
        SmartAccount account = _deployed();
        PackedUserOperation memory op = _op(address(account), "", "");
        bytes32 hash = entryPoint.getUserOpHash(op);

        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerKey, hash);

        bytes[3] memory bad = [
            abi.encodePacked(r, s, v), // someone else's key
            bytes(hex"deadbeef"), // malformed
            new bytes(65) // all zeros: recovers to nothing
        ];

        for (uint256 i; i < bad.length; ++i) {
            op.signature = bad[i];
            vm.prank(address(entryPoint));
            assertEq(account.validateUserOp(op, hash, 0), 1, "a failure verdict, not a revert");
        }

        (v, r, s) = vm.sign(ownerKey, hash);
        op.signature = abi.encodePacked(r, s, v);
        vm.prank(address(entryPoint));
        assertEq(account.validateUserOp(op, hash, 0), 0);
    }

    function test_AcceptsDirectDeposits() public {
        SmartAccount account = _deployed();
        (bool ok,) = address(account).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(account).balance, 1 ether);
    }

    function _deployed() internal returns (SmartAccount account) {
        vm.prank(address(factory.senderCreator()));
        account = factory.createAccount(owner, 0);
    }
}
