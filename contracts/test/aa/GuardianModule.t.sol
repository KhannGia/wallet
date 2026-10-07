// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {GuardianModule} from "../../src/aa/GuardianModule.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {GuardianModuleBase} from "./GuardianModuleBase.sol";

contract GuardianModuleTest is GuardianModuleBase {
    address internal newOwner;
    uint256 internal newOwnerKey;

    function setUp() public override {
        super.setUp();
        (newOwner, newOwnerKey) = makeAddrAndKey("newOwner");
    }

    function test_StoresTheAccountsChoices() public view {
        assertEq(account.recoveryModule(), address(module));
        assertEq(module.threshold(address(account)), QUORUM);
        assertEq(module.guardians(address(account)).length, GUARDIAN_COUNT);
        for (uint256 i; i < GUARDIAN_COUNT; ++i) {
            assertTrue(module.isGuardian(address(account), guardians[i]));
        }
    }

    /// The demo P12 exists for: the key is gone, three guardians approve, and
    /// after the delay the account answers to a new key -- and not the old one.
    function test_GuardiansRecoverALostKey() public {
        vm.expectEmit(address(module));
        emit GuardianModule.RecoveryStarted(address(account), newOwner, block.timestamp + 48 hours);
        _startRecovery(newOwner);

        vm.warp(block.timestamp + module.RECOVERY_DELAY());
        vm.expectEmit(address(account));
        emit SmartAccount.OwnerChanged(owner, newOwner);
        module.executeRecovery(address(account));

        assertEq(account.owner(), newOwner);

        _asOwnerWith(newOwnerKey, _execute(RECIPIENT, 1 wei, ""));
        assertEq(RECIPIENT.balance, 1 wei);

        PackedUserOperation memory stale =
            _signWith(ownerKey, _op(address(account), "", _execute(RECIPIENT, 1, "")));
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error")
        );
        _submit(stale);
    }

    function test_RevertWhen_ExecutedBeforeTheDelay() public {
        _startRecovery(newOwner);
        uint256 ready = block.timestamp + module.RECOVERY_DELAY();

        vm.warp(ready - 1);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.NotReady.selector, ready, ready - 1));
        module.executeRecovery(address(account));
    }

    function test_RevertWhen_TheRecoveryLapsed() public {
        _startRecovery(newOwner);
        uint256 lapses = block.timestamp + module.RECOVERY_DELAY() + module.EXECUTION_WINDOW();

        vm.warp(lapses + 1);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.Lapsed.selector, lapses, lapses + 1));
        module.executeRecovery(address(account));
    }

    function test_OwnerCancelsThroughTheAccount() public {
        _startRecovery(newOwner);

        vm.expectEmit(address(module));
        emit GuardianModule.RecoveryCancelled(address(account), address(account));
        _asOwner(_execute(address(module), 0, abi.encodeCall(GuardianModule.cancelRecovery, ())));

        vm.warp(block.timestamp + module.RECOVERY_DELAY());
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, address(account))
        );
        module.executeRecovery(address(account));
        assertEq(account.owner(), owner);
    }

    function test_GuardiansWithdrawTheirOwnRecovery() public {
        _startRecovery(newOwner);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            module.hashCancel(address(account), module.nonce(address(account)), deadline);

        module.cancelRecoveryWithGuardians(
            address(account), deadline, _signDigest(digest, [uint256(1), 3, 4])
        );

        (, uint64 executableAt) = module.pending(address(account));
        assertEq(executableAt, 0);
    }

    function test_ChangingGuardiansCancelsARecoveryInProgress() public {
        _startRecovery(newOwner);
        address[] memory fresh = new address[](1);
        fresh[0] = makeAddr("freshGuardian");

        _asOwner(_configureRecovery(fresh, 1));

        (, uint64 executableAt) = module.pending(address(account));
        assertEq(executableAt, 0);
        assertFalse(module.isGuardian(address(account), guardians[0]), "old guardians are gone");
        assertTrue(module.isGuardian(address(account), fresh[0]));
    }

    function test_OwnerRotatesTheirOwnKey() public {
        _asOwner(
            _execute(
                address(account), 0, abi.encodeCall(SmartAccount.transferOwnership, (newOwner))
            )
        );
        assertEq(account.owner(), newOwner);
    }

    function test_RevertWhen_OwnershipGoesToTheZeroAddress() public {
        // The constructor's rule, kept on every later change of owner: a
        // malformed signature recovers to the zero address.
        vm.prank(address(account));
        vm.expectRevert(SmartAccount.InvalidOwner.selector);
        account.transferOwnership(address(0));
    }

    function test_RemovingTheModuleStopsRecovery() public {
        _startRecovery(newOwner);
        _asOwner(
            _execute(
                address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (address(0)))
            )
        );

        vm.warp(block.timestamp + module.RECOVERY_DELAY());
        vm.expectRevert(SmartAccount.OnlyOwnerOrRecovery.selector);
        module.executeRecovery(address(account));
    }

    // --- refusals -------------------------------------------------------------

    function test_RevertWhen_GuardianSetIsInvalid() public {
        address[] memory set = new address[](2);
        (set[0], set[1]) = (guardians[0], guardians[1]);

        vm.startPrank(address(account));
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidThreshold.selector, 0, 2));
        module.setGuardians(set, 0);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidThreshold.selector, 3, 2));
        module.setGuardians(set, 3);

        address[] memory tooMany = new address[](11);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidThreshold.selector, 1, 11));
        module.setGuardians(tooMany, 1);

        set[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidGuardian.selector, address(0)));
        module.setGuardians(set, 1);

        set[1] = address(account);
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.InvalidGuardian.selector, address(account))
        );
        module.setGuardians(set, 1);

        // An owner as guardian would count towards replacing their own key.
        set[1] = owner;
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidGuardian.selector, owner));
        module.setGuardians(set, 1);

        set[1] = guardians[0];
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.DuplicateGuardian.selector, guardians[0])
        );
        module.setGuardians(set, 1);
        vm.stopPrank();
    }

    function test_RevertWhen_RecoveryIsMalformed() public {
        uint256 deadline = block.timestamp + 1 hours;

        bytes[] memory approvals = _approvals(address(0), deadline);
        vm.expectRevert(abi.encodeWithSelector(GuardianModule.InvalidNewOwner.selector, address(0)));
        module.initiateRecovery(address(account), address(0), deadline, approvals);

        _startRecovery(newOwner);
        approvals = _approvals(newOwner, deadline);
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.RecoveryPending.selector, address(account))
        );
        module.initiateRecovery(address(account), newOwner, deadline, approvals);
    }

    function test_RevertWhen_TheDeadlinePassed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory approvals = _approvals(newOwner, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.Expired.selector, deadline, deadline + 1)
        );
        module.initiateRecovery(address(account), newOwner, deadline, approvals);
    }

    function test_RevertWhen_TheAccountNeverChoseThisModule() public {
        // A second account with no module configured at all.
        vm.deal(factory.getAddress(owner, 1), 1 ether);
        SmartAccount bare = _deployAndCall(1, RECIPIENT, 0, "");

        bytes[] memory none = new bytes[](0);
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NotRecoveryModule.selector, address(bare))
        );
        module.initiateRecovery(address(bare), newOwner, block.timestamp + 1, none);
    }

    function test_RevertWhen_NothingIsPending() public {
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, address(account))
        );
        module.executeRecovery(address(account));

        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, address(account))
        );
        module.cancelRecovery();

        bytes[] memory none = new bytes[](0);
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, address(account))
        );
        module.cancelRecoveryWithGuardians(address(account), block.timestamp + 1, none);
    }

    function test_RevertWhen_NoGuardiansAreRegistered() public {
        // Opted into the module but never registered anyone: a quorum of zero
        // must not mean "no signatures needed".
        vm.deal(factory.getAddress(owner, 2), 1 ether);
        SmartAccount bare = _deployAndCall(2, RECIPIENT, 0, "");
        vm.prank(address(bare));
        bare.setRecoveryModule(address(module));

        bytes[] memory none = new bytes[](0);
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.SignatureCountMismatch.selector, 0, 0)
        );
        module.initiateRecovery(address(bare), newOwner, block.timestamp + 1, none);
    }
}
