// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {VerifyingPaymaster} from "../../src/aa/VerifyingPaymaster.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {PaymasterBase} from "./PaymasterBase.sol";

contract VerifyingPaymasterTest is PaymasterBase {
    function _transferUsdc(uint256 amount) internal view returns (bytes memory) {
        return _execute(address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, amount)));
    }

    /// The demo P11 exists for: an account that has never held ether deploys
    /// itself and moves USDC, and the paymaster pays for all of it.
    function test_AccountWithNoEtherPaysUsdc() public {
        address account = factory.getAddress(owner, 0);
        token.mint(account, 500_000_000);
        assertEq(account.balance, 0);

        uint256 depositBefore = paymaster.getDeposit();
        PackedUserOperation memory op =
            _sponsored(_op(account, _initCode(owner, 0), _transferUsdc(200_000_000)));
        _submit(_signWith(ownerKey, op));

        assertGt(account.code.length, 0, "deployed by the sponsored operation");
        assertEq(token.balanceOf(RECIPIENT), 200_000_000);
        assertEq(account.balance, 0, "never needed any ether");
        assertEq(entryPoint.balanceOf(account), 0, "nor a deposit of its own");

        // Every wei the bundler was repaid came out of the paymaster's deposit.
        assertGt(bundler.balance, 0);
        assertEq(depositBefore - paymaster.getDeposit(), bundler.balance);
    }

    function test_SponsorsLaterOperationsToo() public {
        address account = factory.getAddress(owner, 0);
        token.mint(account, 500_000_000);
        _submit(
            _signWith(ownerKey, _sponsored(_op(account, _initCode(owner, 0), _transferUsdc(1))))
        );

        _submit(_signWith(ownerKey, _sponsored(_op(account, "", _transferUsdc(2)))));

        assertEq(token.balanceOf(RECIPIENT), 3);
        assertEq(entryPoint.getNonce(account, 0), 2);
    }

    function test_HashBindsChainAndPaymaster() public {
        PackedUserOperation memory op = _op(factory.getAddress(owner, 0), "", "");
        op.paymasterAndData = _gasPrefix(paymaster);
        bytes32 here = paymaster.hashSponsorship(op, 100, 0);

        VerifyingPaymaster other = new VerifyingPaymaster(entryPoint, sponsor, paymasterOwner);
        assertTrue(other.hashSponsorship(op, 100, 0) != here);

        vm.chainId(block.chainid + 1);
        assertTrue(paymaster.hashSponsorship(op, 100, 0) != here);
    }

    // --- deposit and stake ----------------------------------------------------

    function test_AnyoneMayTopUpTheDeposit() public {
        uint256 before = paymaster.getDeposit();
        vm.deal(RECIPIENT, 1 ether);
        vm.prank(RECIPIENT);
        paymaster.deposit{value: 1 ether}();
        assertEq(paymaster.getDeposit(), before + 1 ether);
    }

    function test_OwnerWithdrawsTheDeposit() public {
        address payable to = payable(makeAddr("treasury"));
        vm.prank(paymasterOwner);
        paymaster.withdrawTo(to, 2 ether);
        assertEq(to.balance, 2 ether);
        assertEq(paymaster.getDeposit(), 8 ether);
    }

    function test_IsStakedAndCanUnstakeAfterTheDelay() public {
        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(paymaster));
        assertTrue(info.staked);
        assertEq(info.stake, 1 ether);
        assertEq(info.unstakeDelaySec, 1 days);

        address payable to = payable(makeAddr("treasury"));
        vm.startPrank(paymasterOwner);
        paymaster.unlockStake();
        vm.warp(block.timestamp + 1 days);
        paymaster.withdrawStake(to);
        vm.stopPrank();

        assertEq(to.balance, 1 ether);
    }

    function test_RevertWhen_SignerIsZero() public {
        vm.expectRevert(VerifyingPaymaster.InvalidSigner.selector);
        new VerifyingPaymaster(entryPoint, address(0), paymasterOwner);
    }

    function test_PostOpIsANoOpForTheEntryPoint() public {
        // Never reached in practice -- validation returns no context -- but the
        // interface requires it, and only the EntryPoint may call it.
        vm.prank(address(entryPoint));
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);

        vm.expectRevert(VerifyingPaymaster.OnlyEntryPoint.selector);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
    }
}
