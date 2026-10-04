// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {AccountFactory} from "../../src/aa/AccountFactory.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {SmartAccountBase} from "./SmartAccountBase.sol";

/// @dev One test per way someone other than the owner might try to make an
///      account act, or to break the owner's own use of it.
contract SmartAccountAttackTest is SmartAccountBase {
    address internal constant ATTACKER = address(0xBAD);
    SmartAccount internal account;

    function setUp() public override {
        super.setUp();
        vm.deal(factory.getAddress(owner, 0), 10 ether);
        account = _deployAndCall(0, RECIPIENT, 0, "");
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    // --- bypassing the EntryPoint ---------------------------------------------

    /// Calling execute directly skips signature validation altogether.
    function test_Attack_OutsiderCallsExecute() public {
        vm.prank(ATTACKER);
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.execute(ATTACKER, 1 ether, "");

        SmartAccount.Call[] memory calls = new SmartAccount.Call[](1);
        calls[0] = SmartAccount.Call(ATTACKER, 1 ether, "");
        vm.prank(ATTACKER);
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.executeBatch(calls);
    }

    /// validateUserOp pays `missingAccountFunds` to its caller. Anyone able to
    /// call it could name the whole balance and be paid it.
    function test_Attack_OutsiderDrainsThroughValidateUserOp() public {
        PackedUserOperation memory op = _op(address(account), "", "");
        uint256 balance = address(account).balance;

        vm.prank(ATTACKER);
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.validateUserOp(op, bytes32(0), balance);

        assertEq(ATTACKER.balance, 0);
    }

    // --- forged and replayed signatures ---------------------------------------

    function test_Attack_SignedByAnotherKey() public {
        (, uint256 attackerKey) = makeAddrAndKey("attacker");
        PackedUserOperation memory op =
            _signWith(attackerKey, _op(address(account), "", _execute(ATTACKER, 1 ether, "")));

        _expectFailedOp("AA24 signature error");
        _submit(op);
    }

    /// The (r, n - s) twin of a valid signature recovers to the same owner. The
    /// account must refuse it, or one approval has two valid encodings.
    function test_Attack_MalleatedSignature() public {
        PackedUserOperation memory op =
            _signWith(ownerKey, _op(address(account), "", _execute(RECIPIENT, 1 wei, "")));
        (bytes32 r, bytes32 s, uint8 v) = _split(op.signature);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        op.signature = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));

        _expectFailedOp("AA24 signature error");
        _submit(op);
    }

    function test_Attack_ReplayedOperation() public {
        PackedUserOperation memory op =
            _signWith(ownerKey, _op(address(account), "", _execute(RECIPIENT, 1 wei, "")));
        _submit(op);

        _expectFailedOp("AA25 invalid account nonce");
        _submit(op);
        assertEq(RECIPIENT.balance, 1 wei);
    }

    /// The same owner's second account: an operation signed for one must not
    /// run on the other, though the owner and nonce match.
    function test_Attack_ReplayedOnAnotherAccountOfTheSameOwner() public {
        address second = factory.getAddress(owner, 1);
        vm.deal(second, 1 ether);
        _deployAndCall(1, RECIPIENT, 0, "");

        PackedUserOperation memory op =
            _signWith(ownerKey, _op(address(account), "", _execute(ATTACKER, 1 ether, "")));
        op.sender = second;

        _expectFailedOp("AA24 signature error");
        _submit(op);
    }

    function test_Attack_ReplayedOnAnotherChain() public {
        PackedUserOperation memory op =
            _signWith(ownerKey, _op(address(account), "", _execute(ATTACKER, 1 ether, "")));

        vm.chainId(block.chainid + 1);
        _expectFailedOp("AA24 signature error");
        _submit(op);
    }

    /// An account behind a second EntryPoint, same owner and salt: the
    /// signature names the EntryPoint it was made for.
    function test_Attack_ReplayedThroughAnotherEntryPoint() public {
        EntryPoint otherEntryPoint = new EntryPoint();
        AccountFactory otherFactory = new AccountFactory(otherEntryPoint);
        address twin = otherFactory.getAddress(owner, 0);
        vm.deal(twin, 1 ether);
        vm.prank(address(otherFactory.senderCreator()));
        otherFactory.createAccount(owner, 0);

        // Identical in every field the twin will check -- sender, nonce, call --
        // and signed by the right owner, but for the first EntryPoint. The
        // only difference left is the EntryPoint the signature names.
        PackedUserOperation memory op = _op(twin, "", _execute(ATTACKER, 1 ether, ""));
        op.nonce = otherEntryPoint.getNonce(twin, 0);
        op = _signWith(ownerKey, op);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        _expectFailedOp("AA24 signature error");
        otherEntryPoint.handleOps(ops, bundler);
    }

    // --- deployment -----------------------------------------------------------

    /// Deploying a victim's account ahead of them cannot steal it -- the owner
    /// is fixed by the address -- but would make their first operation fail.
    function test_Attack_FrontRunsTheDeployment() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AccountFactory.OnlySenderCreator.selector);
        factory.createAccount(makeAddr("victim"), 0);
    }

    /// Claiming a victim's counterfactual address with initCode that deploys an
    /// account owned by the attacker.
    function test_Attack_InitCodeForAnotherOwner() public {
        address victimAddress = factory.getAddress(makeAddr("victim"), 0);
        vm.deal(victimAddress, 1 ether);
        (address attacker, uint256 attackerKey) = makeAddrAndKey("attacker");

        PackedUserOperation memory op = _signWith(
            attackerKey, _op(victimAddress, _initCode(attacker, 0), _execute(ATTACKER, 1 ether, ""))
        );

        _expectFailedOp("AA14 initCode must return sender");
        _submit(op);
        assertEq(victimAddress.balance, 1 ether);
    }

    /// A garbage signature recovers to the zero address, so an account owned by
    /// the zero address would answer to anyone. None can exist.
    function test_Attack_AccountOwnedByTheZeroAddress() public {
        vm.prank(address(factory.senderCreator()));
        vm.expectRevert(SmartAccount.InvalidOwner.selector);
        factory.createAccount(address(0), 0);
    }

    /// An account with nothing to pay gas with cannot make the bundler eat the
    /// cost: the EntryPoint refuses the operation before running it.
    function test_Attack_OperationThatCannotPayForItself() public {
        address broke = factory.getAddress(owner, 2);
        PackedUserOperation memory op =
            _signWith(ownerKey, _op(broke, _initCode(owner, 2), _execute(RECIPIENT, 0, "")));

        _expectFailedOp("AA21 didn't pay prefund");
        _submit(op);
    }

    function _split(bytes memory signature) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
    }
}
