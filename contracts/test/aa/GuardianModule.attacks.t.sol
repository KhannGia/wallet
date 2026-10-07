// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {GuardianModule} from "../../src/aa/GuardianModule.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {GuardianModuleBase} from "./GuardianModuleBase.sol";

/// @dev One test per way to take an account through recovery that its owner
///      and its guardians did not agree to.
contract GuardianModuleAttackTest is GuardianModuleBase {
    address internal constant THIEF = address(0xBAD);

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _expectNotAGuardian() internal {
        // The digest differs, so the signature recovers to some unrelated address.
        vm.expectPartialRevert(GuardianModule.NotAGuardian.selector);
    }

    // --- collusion ------------------------------------------------------------

    /// The scenario the delay exists for: three guardians conspire to hand the
    /// account to themselves, and the owner -- whose key still works -- vetoes.
    function test_Attack_ColludingGuardiansVetoedByTheOwner() public {
        _startRecovery(THIEF);

        _asOwner(_execute(address(module), 0, abi.encodeCall(GuardianModule.cancelRecovery, ())));

        vm.warp(block.timestamp + module.RECOVERY_DELAY());
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, address(account))
        );
        module.executeRecovery(address(account));
        assertEq(account.owner(), owner);
    }

    function test_Attack_FewerThanAQuorum() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);
        bytes[] memory two = new bytes[](2);
        (two[0], two[1]) = (approvals[0], approvals[1]);

        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.SignatureCountMismatch.selector, 2, 3)
        );
        module.initiateRecovery(address(account), THIEF, deadline, two);
    }

    /// One guardian's signature presented three times as a quorum.
    function test_Attack_OneGuardianCountedThrice() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);
        approvals[1] = approvals[0];
        approvals[2] = approvals[0];

        vm.expectPartialRevert(GuardianModule.SignersNotAscending.selector);
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    function test_Attack_OutsidersFormAQuorum() public {
        uint256 deadline = _deadline();
        bytes32 digest =
            module.hashRecovery(address(account), THIEF, module.nonce(address(account)), deadline);
        bytes[] memory forged = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            (, uint256 key) = makeAddrAndKey(string.concat("outsider", vm.toString(i)));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
            forged[i] = abi.encodePacked(r, s, v);
        }
        _sortBySigner(forged, digest);

        _expectNotAGuardian();
        module.initiateRecovery(address(account), THIEF, deadline, forged);
    }

    function test_Attack_MalleatedGuardianSignature() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);
        (bytes32 r, bytes32 s, uint8 v) = _split(approvals[0]);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flipped = bytes32(n - uint256(s));
        approvals[0] = abi.encodePacked(r, flipped, v == 27 ? uint8(28) : uint8(27));

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, flipped));
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    // --- replay ---------------------------------------------------------------

    /// Approvals for a recovery the owner cancelled, presented again.
    function test_Attack_CancelledApprovalsReused() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
        _asOwner(_execute(address(module), 0, abi.encodeCall(GuardianModule.cancelRecovery, ())));

        _expectNotAGuardian();
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    /// Approvals that already recovered the account, presented again to start
    /// a second recovery -- with a deadline long enough to outlast the delay,
    /// so expiry is not what stops them.
    function test_Attack_UsedApprovalsStartAnotherRecovery() public {
        uint256 deadline = block.timestamp + 60 days;
        bytes[] memory approvals = _approvals(THIEF, deadline);
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
        vm.warp(block.timestamp + module.RECOVERY_DELAY());
        module.executeRecovery(address(account));

        _expectNotAGuardian();
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    /// Two accounts sharing the same guardians: approvals for one must not
    /// recover the other.
    function test_Attack_ApprovalsForAnotherAccount() public {
        vm.deal(factory.getAddress(owner, 1), 1 ether);
        SmartAccount sibling = _deployAndCall(1, RECIPIENT, 0, "");
        SmartAccount first = account;
        account = sibling;
        _asOwner(_configureRecovery(guardians, QUORUM));

        uint256 deadline = _deadline();
        account = first;
        bytes[] memory forFirst = _approvals(THIEF, deadline);

        _expectNotAGuardian();
        module.initiateRecovery(address(sibling), THIEF, deadline, forFirst);
    }

    function test_Attack_ApprovalsFromAnotherChain() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);

        vm.chainId(block.chainid + 1);
        _expectNotAGuardian();
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    /// Guardians the owner has since replaced, starting a recovery anyway.
    function test_Attack_RemovedGuardiansStillApprove() public {
        uint256 deadline = _deadline();
        bytes[] memory approvals = _approvals(THIEF, deadline);

        address[] memory fresh = new address[](1);
        fresh[0] = makeAddr("freshGuardian");
        _asOwner(_configureRecovery(fresh, 1));

        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.SignatureCountMismatch.selector, 3, 1)
        );
        module.initiateRecovery(address(account), THIEF, deadline, approvals);
    }

    /// A guardians' cancellation, signed for one recovery, kept and replayed
    /// against a later one to stop it.
    function test_Attack_CancellationReplayedAgainstALaterRecovery() public {
        _startRecovery(THIEF);
        uint256 deadline = _deadline();
        bytes32 digest =
            module.hashCancel(address(account), module.nonce(address(account)), deadline);
        bytes[] memory cancel = _signDigest(digest, [uint256(0), 1, 2]);
        module.cancelRecoveryWithGuardians(address(account), deadline, cancel);

        address genuine = makeAddr("genuineNewOwner");
        _startRecovery(genuine);

        _expectNotAGuardian();
        module.cancelRecoveryWithGuardians(address(account), deadline, cancel);
    }

    // --- outsiders ------------------------------------------------------------

    function test_Attack_OutsiderTakesOwnershipDirectly() public {
        vm.prank(THIEF);
        vm.expectRevert(SmartAccount.OnlyOwnerOrRecovery.selector);
        account.transferOwnership(THIEF);

        vm.prank(THIEF);
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.setRecoveryModule(THIEF);
    }

    /// setGuardians and cancelRecovery act on the caller, never on an account
    /// named in the arguments. An outsider cannot even configure their own
    /// address: the module reads the caller's owner(), which an ordinary
    /// account does not have.
    function test_Attack_OutsiderReconfiguresOrCancelsForTheVictim() public {
        _startRecovery(makeAddr("genuineNewOwner"));
        address[] memory own = new address[](1);
        own[0] = THIEF;

        vm.prank(makeAddr("outsider"));
        vm.expectRevert();
        module.setGuardians(own, 1);

        vm.prank(makeAddr("outsider"));
        vm.expectRevert(
            abi.encodeWithSelector(GuardianModule.NoRecoveryPending.selector, makeAddr("outsider"))
        );
        module.cancelRecovery();

        assertFalse(module.isGuardian(address(account), THIEF));
        (, uint64 executableAt) = module.pending(address(account));
        assertGt(executableAt, 0, "the victim's recovery is untouched");
    }

    /// The account calling transferOwnership on itself with no module and no
    /// signed operation is impossible: only a validated operation runs code as
    /// the account. A module the owner removed is no longer trusted at all.
    function test_Attack_ModuleRemovedThenUsed() public {
        _asOwner(
            _execute(
                address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (address(0)))
            )
        );

        vm.prank(address(module));
        vm.expectRevert(SmartAccount.OnlyOwnerOrRecovery.selector);
        account.transferOwnership(THIEF);
    }

    // --- helpers --------------------------------------------------------------

    function _split(bytes memory signature) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
    }

    function _sortBySigner(bytes[] memory sigs, bytes32 digest) internal pure {
        for (uint256 i = 1; i < sigs.length; ++i) {
            for (
                uint256 j = i;
                j > 0 && ECDSA.recover(digest, sigs[j - 1]) > ECDSA.recover(digest, sigs[j]);
                --j
            ) {
                (sigs[j - 1], sigs[j]) = (sigs[j], sigs[j - 1]);
            }
        }
    }
}
