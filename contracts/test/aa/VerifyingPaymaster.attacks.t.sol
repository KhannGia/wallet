// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {VerifyingPaymaster} from "../../src/aa/VerifyingPaymaster.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {PaymasterBase} from "./PaymasterBase.sol";

/// @dev One test per way to get gas paid that the sponsor never agreed to.
contract VerifyingPaymasterAttackTest is PaymasterBase {
    address internal constant ATTACKER = address(0xBAD);
    address internal account;

    function setUp() public override {
        super.setUp();
        account = factory.getAddress(owner, 0);
        token.mint(account, 1_000_000);
        // Deployed by a first sponsored operation, so later tests start from
        // an account at nonce 1.
        _submit(_signWith(ownerKey, _sponsored(_op(account, _initCode(owner, 0), _transfer(1)))));
    }

    function _transfer(uint256 amount) internal view returns (bytes memory) {
        return _execute(address(token), 0, abi.encodeCall(MockERC20.transfer, (RECIPIENT, amount)));
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    // --- forged sponsorships --------------------------------------------------

    function test_Attack_SponsorshipFromAStranger() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        PackedUserOperation memory op = _sponsorWith(
            paymaster,
            strangerKey,
            _op(account, "", _transfer(1)),
            uint48(block.timestamp + 1 hours),
            0
        );

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA34 signature error");

        _submit(op);
    }

    /// Sponsored for one call, then the call is swapped for another -- an
    /// approve to the attacker, say -- and the account re-signs.
    function test_Attack_DifferentCallUnderTheSameSponsorship() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        op.callData =
            _execute(address(token), 0, abi.encodeCall(MockERC20.approve, (ATTACKER, 1e18)));

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA34 signature error");

        _submit(op);
    }

    /// A sponsorship that was used, presented again for the next operation.
    function test_Attack_SponsorshipReusedForTheNextNonce() public {
        PackedUserOperation memory first = _sponsored(_op(account, "", _transfer(1)));
        _submit(_signWith(ownerKey, first));

        PackedUserOperation memory second = _op(account, "", _transfer(1));
        second.paymasterAndData = first.paymasterAndData;

        second = _signWith(ownerKey, second);

        _expectFailedOp("AA34 signature error");

        _submit(second);
    }

    /// The paymaster pays up to gas limit times fee. Raising either after the
    /// sponsor signed would make it pay more than it agreed to.
    function test_Attack_AccountRaisesGasAfterTheSponsorSigned() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        op.gasFees = bytes32((uint256(100 gwei) << 128) | uint256(200 gwei));
        op = _signWith(ownerKey, op);
        _expectFailedOp("AA34 signature error");
        _submit(op);

        op = _sponsored(_op(account, "", _transfer(1)));
        op.accountGasLimits = bytes32((uint256(10_000_000) << 128) | uint256(10_000_000));
        op = _signWith(ownerKey, op);
        _expectFailedOp("AA34 signature error");
        _submit(op);

        op = _sponsored(_op(account, "", _transfer(1)));
        op.preVerificationGas = 5_000_000;
        op = _signWith(ownerKey, op);
        _expectFailedOp("AA34 signature error");
        _submit(op);
    }

    function test_Attack_RaisesThePaymasterGasLimit() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        bytes memory data = op.paymasterAndData;
        // Overwrite the verification gas limit, bytes 20..36.
        bytes16 raised = bytes16(uint128(1_000_000));
        for (uint256 i; i < 16; ++i) {
            data[20 + i] = raised[i];
        }
        op.paymasterAndData = data;

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA34 signature error");

        _submit(op);
    }

    // --- time -----------------------------------------------------------------

    function test_Attack_ExpiredSponsorship() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        vm.warp(block.timestamp + 1 hours + 1);

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA32 paymaster expired or not due");

        _submit(op);
    }

    function test_Attack_SponsorshipUsedBeforeItStarts() public {
        PackedUserOperation memory op = _sponsorWith(
            paymaster,
            sponsorKey,
            _op(account, "", _transfer(1)),
            uint48(block.timestamp + 2 hours),
            uint48(block.timestamp + 1 hours)
        );

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA32 paymaster expired or not due");

        _submit(op);
    }

    /// validUntil of zero means "forever" in ERC-4337. A genuine signature over
    /// such a sponsorship is still refused: every sponsorship must run out.
    function test_Attack_SponsorshipThatNeverExpires() public {
        PackedUserOperation memory op =
            _sponsorWith(paymaster, sponsorKey, _op(account, "", _transfer(1)), 0, 0);

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA34 signature error");

        _submit(op);
    }

    // --- replay ---------------------------------------------------------------

    function test_Attack_ReplayedOnAnotherChain() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        vm.chainId(block.chainid + 1);

        // Re-signed by the account for this chain, so only the sponsorship is stale.
        op = _signWith(ownerKey, op);
        _expectFailedOp("AA34 signature error");
        _submit(op);
    }

    /// Two paymasters trusting the same signer: a sponsorship for one must not
    /// spend the other's deposit.
    function test_Attack_ReplayedOnAnotherPaymaster() public {
        VerifyingPaymaster other = new VerifyingPaymaster(entryPoint, sponsor, paymasterOwner);
        vm.deal(address(this), 5 ether);
        other.deposit{value: 5 ether}();

        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        bytes memory data = op.paymasterAndData;
        bytes20 otherAddress = bytes20(address(other));
        for (uint256 i; i < 20; ++i) {
            data[i] = otherAddress[i];
        }
        op.paymasterAndData = data;

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA34 signature error");

        _submit(op);
        assertEq(other.getDeposit(), 5 ether);
    }

    // --- malformed and unfunded -----------------------------------------------

    function test_Attack_TruncatedPaymasterData() public {
        PackedUserOperation memory op = _op(account, "", _transfer(1));
        op.paymasterAndData = abi.encodePacked(_gasPrefix(paymaster), uint48(1), uint48(0));

        op = _signWith(ownerKey, op);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA33 reverted",
                abi.encodeWithSelector(VerifyingPaymaster.InvalidPaymasterData.selector, 64)
            )
        );
        _submit(op);
    }

    function test_Attack_PaymasterWithNoDeposit() public {
        VerifyingPaymaster empty = new VerifyingPaymaster(entryPoint, sponsor, paymasterOwner);
        PackedUserOperation memory op = _sponsorWith(
            empty, sponsorKey, _op(account, "", _transfer(1)), uint48(block.timestamp + 1 hours), 0
        );

        op = _signWith(ownerKey, op);

        _expectFailedOp("AA31 paymaster deposit too low");

        _submit(op);
    }

    // --- the deposit itself ---------------------------------------------------

    function test_Attack_OutsiderDrainsTheDeposit() public {
        vm.startPrank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        paymaster.withdrawTo(payable(ATTACKER), 1 ether);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        paymaster.unlockStake();

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        paymaster.withdrawStake(payable(ATTACKER));
        vm.stopPrank();
    }

    function test_Attack_OutsiderCallsValidationDirectly() public {
        PackedUserOperation memory op = _sponsored(_op(account, "", _transfer(1)));
        vm.prank(ATTACKER);
        vm.expectRevert(VerifyingPaymaster.OnlyEntryPoint.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1 ether);
    }
}
