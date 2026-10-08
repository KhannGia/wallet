// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SessionKeysBase} from "./SessionKeysBase.sol";

contract SessionKeysTest is SessionKeysBase {
    address internal constant FRIEND = address(0xF00D);

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    /// The demo P13 exists for: a 24-hour key that can only transfer USDC,
    /// up to a cap, used without the owner's key.
    function test_SessionTransfersWithinItsScope() public {
        _grantTransfers();

        _submit(_bySession(_transfer(FRIEND, 60_000_000)));

        assertEq(token.balanceOf(FRIEND), 60_000_000);
        assertEq(_spent(), 60_000_000);
    }

    function test_StoresTheSession() public {
        _grantTransfers();

        (bool active, uint48 validAfter, uint48 validUntil,,) = account.sessions(sessionKey);
        assertTrue(active);
        assertEq(validAfter, 0);
        assertEq(validUntil, block.timestamp + 24 hours);
        SmartAccount.Permission[] memory permissions = account.permissionsOf(sessionKey);
        assertEq(permissions.length, 1);
        assertEq(permissions[0].target, address(token));
        assertEq(permissions[0].selector, MockERC20.transfer.selector);
        (bool capped, uint256 limit,) = account.tokenAllowances(sessionKey, address(token));
        assertTrue(capped);
        assertEq(limit, CAP);
    }

    /// The cap is counted in execution: an operation past it reverts there.
    /// The EntryPoint still charges for the attempt -- the price of counting
    /// at execution rather than validation.
    function test_TheCapHoldsAcrossOperations() public {
        _grantTransfers();
        _submit(_bySession(_transfer(FRIEND, 60_000_000)));

        PackedUserOperation memory over = _bySession(_transfer(FRIEND, 60_000_000));
        vm.expectEmit(true, true, true, false, address(entryPoint));
        emit IEntryPoint.UserOperationEvent(
            entryPoint.getUserOpHash(over), address(account), address(0), over.nonce, false, 0, 0
        );
        _submit(over);

        assertEq(token.balanceOf(FRIEND), 60_000_000, "the second transfer never happened");
        assertEq(_spent(), 60_000_000);
    }

    function test_ConditionsBindTheArguments() public {
        SmartAccount.Condition[] memory conditions = new SmartAccount.Condition[](2);
        // To FRIEND only, and no more than 50 USDC a time.
        conditions[0] = SmartAccount.Condition(
            0, SmartAccount.Operator.Equal, bytes32(uint256(uint160(FRIEND)))
        );
        conditions[1] = SmartAccount.Condition(
            1, SmartAccount.Operator.LessOrEqual, bytes32(uint256(50_000_000))
        );
        _grant(
            0, uint48(block.timestamp + 1 days), 0, _one(_transferPermission(conditions)), _cap(CAP)
        );

        _submit(_bySession(_transfer(FRIEND, 40_000_000)));
        assertEq(token.balanceOf(FRIEND), 40_000_000);

        PackedUserOperation memory elsewhere = _bySession(_transfer(RECIPIENT, 1));
        _expectFailedOp("AA24 signature error");
        _submit(elsewhere);

        PackedUserOperation memory tooMuch = _bySession(_transfer(FRIEND, 50_000_001));
        _expectFailedOp("AA24 signature error");
        _submit(tooMuch);
    }

    function test_GreaterOrEqualCondition() public {
        SmartAccount.Condition[] memory conditions = new SmartAccount.Condition[](1);
        conditions[0] =
            SmartAccount.Condition(1, SmartAccount.Operator.GreaterOrEqual, bytes32(uint256(10)));
        _grant(
            0, uint48(block.timestamp + 1 days), 0, _one(_transferPermission(conditions)), _cap(CAP)
        );

        _submit(_bySession(_transfer(FRIEND, 10)));
        assertEq(token.balanceOf(FRIEND), 10);

        PackedUserOperation memory below = _bySession(_transfer(FRIEND, 9));
        _expectFailedOp("AA24 signature error");
        _submit(below);
    }

    function test_AConditionOnAMissingArgumentFails() public {
        SmartAccount.Condition[] memory conditions = new SmartAccount.Condition[](1);
        conditions[0] = SmartAccount.Condition(5, SmartAccount.Operator.Equal, bytes32(0));
        _grant(
            0, uint48(block.timestamp + 1 days), 0, _one(_transferPermission(conditions)), _noCaps()
        );

        PackedUserOperation memory op = _bySession(_transfer(FRIEND, 1));
        _expectFailedOp("AA24 signature error");
        _submit(op);
    }

    /// The window goes back to the EntryPoint; validation never reads the clock.
    function test_OnlyInsideItsValidityWindow() public {
        uint48 start = uint48(block.timestamp + 1 hours);
        _grant(start, start + 1 hours, 0, _one(_transferPermission(_noConditions())), _cap(CAP));

        PackedUserOperation memory early = _bySession(_transfer(FRIEND, 1));
        _expectFailedOp("AA22 expired or not due");
        _submit(early);

        // Strictly after validAfter: the EntryPoint treats the boundary second
        // itself as "not due" yet.
        vm.warp(start);
        PackedUserOperation memory boundary = _bySession(_transfer(FRIEND, 1));
        _expectFailedOp("AA22 expired or not due");
        _submit(boundary);

        vm.warp(start + 1);
        _submit(_bySession(_transfer(FRIEND, 1)));

        vm.warp(start + 1 hours + 1);
        PackedUserOperation memory late = _bySession(_transfer(FRIEND, 1));
        _expectFailedOp("AA22 expired or not due");
        _submit(late);
    }

    function test_SendsPlainEtherWithinANativeLimit() public {
        SmartAccount.Condition[] memory none = _noConditions();
        _grant(
            0,
            uint48(block.timestamp + 1 days),
            1 ether,
            _one(SmartAccount.Permission(FRIEND, bytes4(0), none)),
            _noCaps()
        );

        _submit(_bySession(_sessionCall(FRIEND, 0.6 ether, "")));
        assertEq(FRIEND.balance, 0.6 ether);

        // Past the native limit: reverts in execution.
        _submit(_bySession(_sessionCall(FRIEND, 0.6 ether, "")));
        assertEq(FRIEND.balance, 0.6 ether);
        (,,,, uint256 nativeSpent) = account.sessions(sessionKey);
        assertEq(nativeSpent, 0.6 ether);
    }

    function test_OwnerKeepsFullPower() public {
        _grantTransfers();

        // Directly, and through executeUserOp, with no cap applied.
        _asOwner(
            _execute(address(token), 0, abi.encodeCall(MockERC20.transfer, (FRIEND, 500_000_000)))
        );
        _asOwner(
            _sessionCall(
                address(token), 0, abi.encodeCall(MockERC20.transfer, (FRIEND, 200_000_000))
            )
        );

        assertEq(token.balanceOf(FRIEND), 700_000_000);
        assertEq(_spent(), 0, "the owner's spending is not the session's");
    }

    function test_SessionAndOwnerDoNotBlockEachOther() public {
        _grantTransfers();
        PackedUserOperation memory bySession = _bySession(_transfer(FRIEND, 1));
        PackedUserOperation memory byOwner =
            _signWith(ownerKey, _op(address(account), "", _execute(RECIPIENT, 1, "")));

        // Separate nonce sequences: both valid in one bundle, in either order.
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        (ops[0], ops[1]) = (byOwner, bySession);
        _submitAll(ops);

        assertEq(token.balanceOf(FRIEND), 1);
        assertEq(RECIPIENT.balance, 1);
    }

    function test_RevokingEndsTheSessionAndClearsIt() public {
        _grantTransfers();
        _submit(_bySession(_transfer(FRIEND, 30_000_000)));

        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));

        PackedUserOperation memory after_ = _bySession(_transfer(FRIEND, 1));
        _expectFailedOp("AA24 signature error");
        _submit(after_);
        assertEq(account.permissionsOf(sessionKey).length, 0);

        // Granted again, it starts from nothing.
        _grantTransfers();
        assertEq(_spent(), 0);
        _submit(_bySession(_transfer(FRIEND, 1)));
        assertEq(token.balanceOf(FRIEND), 30_000_001);
    }

    // --- refusals -------------------------------------------------------------

    function test_RevertWhen_SessionIsInvalid() public {
        SmartAccount.Permission[] memory none = new SmartAccount.Permission[](0);
        uint48 until = uint48(block.timestamp + 1 days);
        vm.startPrank(address(account));

        vm.expectRevert(abi.encodeWithSelector(SmartAccount.InvalidSessionKey.selector, address(0)));
        account.addSession(address(0), 0, until, 0, none, _noCaps());

        vm.expectRevert(abi.encodeWithSelector(SmartAccount.InvalidSessionKey.selector, owner));
        account.addSession(owner, 0, until, 0, none, _noCaps());

        // A session that never expires, or ends before it starts.
        vm.expectRevert(abi.encodeWithSelector(SmartAccount.InvalidValidity.selector, 0, 0));
        account.addSession(sessionKey, 0, 0, 0, none, _noCaps());
        vm.expectRevert(abi.encodeWithSelector(SmartAccount.InvalidValidity.selector, until, until));
        account.addSession(sessionKey, until, until, 0, none, _noCaps());

        account.addSession(sessionKey, 0, until, 0, none, _noCaps());
        vm.expectRevert(abi.encodeWithSelector(SmartAccount.SessionExists.selector, sessionKey));
        account.addSession(sessionKey, 0, until, 0, none, _noCaps());

        vm.expectRevert(abi.encodeWithSelector(SmartAccount.SessionInactive.selector, RECIPIENT));
        account.revokeSession(RECIPIENT);
        vm.stopPrank();
    }

    function test_RevertWhen_ExecuteUserOpIsCalledDirectly() public {
        PackedUserOperation memory op = _bySession(_transfer(FRIEND, 1));
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.executeUserOp(op, bytes32(0));
    }

    function test_AFailedCallRevertsInExecution() public {
        // The owner, through executeUserOp, calling something that reverts.
        _asOwner(
            _sessionCall(address(token), 0, abi.encodeCall(MockERC20.transfer, (FRIEND, 10 ** 30)))
        );
        assertEq(token.balanceOf(FRIEND), 0);
    }
}
