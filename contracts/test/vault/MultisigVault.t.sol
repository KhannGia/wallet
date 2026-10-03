// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {MultisigVault} from "../../src/vault/MultisigVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MultisigVaultBase} from "./MultisigVaultBase.sol";

contract MultisigVaultTest is MultisigVaultBase {
    // --- construction ---------------------------------------------------------

    function test_StoresOwnersAndThreshold() public view {
        assertEq(vault.threshold(), THRESHOLD);
        assertEq(vault.owners().length, OWNER_COUNT);
        for (uint256 i; i < OWNER_COUNT; ++i) {
            assertTrue(vault.isOwner(owners[i]));
        }
        assertFalse(vault.isOwner(RECIPIENT));
    }

    function test_RevertWhen_ThresholdIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.InvalidThreshold.selector, 0, 5));
        new MultisigVault(owners, 0, _noTimelock());
    }

    function test_RevertWhen_ThresholdExceedsOwners() public {
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.InvalidThreshold.selector, 6, 5));
        new MultisigVault(owners, 6, _noTimelock());
    }

    function test_RevertWhen_OwnerIsZeroAddress() public {
        address[] memory bad = new address[](2);
        bad[0] = owners[0];
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.InvalidOwner.selector, address(0)));
        new MultisigVault(bad, 1, _noTimelock());
    }

    function test_RevertWhen_OwnerIsDuplicated() public {
        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (owners[0], owners[0]);
        vm.expectRevert(abi.encodeWithSelector(MultisigVault.DuplicateOwner.selector, owners[0]));
        new MultisigVault(dup, 1, _noTimelock());
    }

    // --- execution ------------------------------------------------------------

    function test_TransfersEtherWithThresholdSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);

        assertEq(RECIPIENT.balance, 1 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_TransfersTokensWithThresholdSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory data = abi.encodeCall(MockERC20.transfer, (RECIPIENT, 250_000_000));
        bytes[] memory sigs = _approve(address(token), 0, data, deadline);

        bytes memory result = vault.execute(address(token), 0, data, deadline, sigs);

        assertEq(token.balanceOf(RECIPIENT), 250_000_000);
        // The vault cannot judge what success means to its target, so the
        // return data is surfaced for the proposer to check.
        assertTrue(abi.decode(result, (bool)));
    }

    function test_AnyThreeOfFiveOwnersCanApprove() public {
        // Every one of the ten possible quorums, not a sample.
        uint256 deadline = block.timestamp + 1 hours;
        uint256 executed;

        for (uint256 a; a < OWNER_COUNT; ++a) {
            for (uint256 b = a + 1; b < OWNER_COUNT; ++b) {
                for (uint256 c = b + 1; c < OWNER_COUNT; ++c) {
                    bytes32 digest =
                        vault.hashExecute(RECIPIENT, 1 wei, "", vault.nonce(), deadline);
                    vault.execute(RECIPIENT, 1 wei, "", deadline, _sign(digest, _indices(a, b, c)));
                    ++executed;
                }
            }
        }

        assertEq(executed, 10);
        assertEq(vault.nonce(), 10);
        assertEq(RECIPIENT.balance, 10 wei);
    }

    function test_EmitsExecuted() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        vm.expectEmit(true, true, false, true, address(vault));
        emit MultisigVault.Executed(0, RECIPIENT, 1 ether, "", "");

        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
    }

    function test_AcceptsDeposits() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit MultisigVault.Deposited(address(this), 2 ether);

        (bool ok,) = address(vault).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, 12 ether);
    }

    // --- rejection ------------------------------------------------------------

    function test_RevertWhen_TooFewSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);
        uint256[] memory two = new uint256[](2);
        (two[0], two[1]) = (0, 1);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.SignatureCountMismatch.selector, 2, 3));
        vault.execute(RECIPIENT, 1 ether, "", deadline, _sign(digest, two));
    }

    function test_RevertWhen_TooManySignatures() public {
        // Exactly `threshold`, no more: extra signatures would otherwise be
        // carried along unchecked.
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);
        uint256[] memory four = new uint256[](4);
        (four[0], four[1], four[2], four[3]) = (0, 1, 2, 3);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.SignatureCountMismatch.selector, 4, 3));
        vault.execute(RECIPIENT, 1 ether, "", deadline, _sign(digest, four));
    }

    function test_RevertWhen_SignerIsNotAnOwner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);

        (address outsider, uint256 outsiderKey) = makeAddrAndKey("outsider");
        bytes[] memory sigs = _sign(digest, _indices(0, 1, 2));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(outsiderKey, digest);
        // Put the outsider where ordering allows it, so the failure is about
        // ownership rather than ordering.
        if (outsider > owners[1]) sigs[2] = abi.encodePacked(r, s, v);
        else sigs[0] = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.NotAnOwner.selector, outsider));
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
    }

    function test_RevertWhen_SignaturesAreNotAscending() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = vault.hashExecute(RECIPIENT, 1 ether, "", 0, deadline);

        vm.expectRevert(
            abi.encodeWithSelector(MultisigVault.SignersNotAscending.selector, owners[2], owners[1])
        );
        vault.execute(RECIPIENT, 1 ether, "", deadline, _sign(digest, _indices(0, 2, 1)));
    }

    function test_RevertWhen_DeadlineHasPassed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        vm.warp(deadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(MultisigVault.Expired.selector, deadline, deadline + 1)
        );
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
    }

    function test_RevertWhen_ApprovalIsReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);

        // Same signatures, but the nonce they cover has been spent: they now
        // recover to unrelated addresses.
        vm.expectRevert();
        vault.execute(RECIPIENT, 1 ether, "", deadline, sigs);
        assertEq(RECIPIENT.balance, 1 ether);
    }

    function test_RevertWhen_SubmitterAltersTheCall() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory sigs = _approve(RECIPIENT, 1 ether, "", deadline);

        // Approved one ether; try to send five with the same signatures.
        vm.expectRevert();
        vault.execute(RECIPIENT, 5 ether, "", deadline, sigs);
    }

    function test_FailedCallRevertsAndKeepsTheNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        // More ether than the vault holds.
        bytes[] memory sigs = _approve(RECIPIENT, 100 ether, "", deadline);

        vm.expectRevert(abi.encodeWithSelector(MultisigVault.CallFailed.selector, ""));
        vault.execute(RECIPIENT, 100 ether, "", deadline, sigs);

        assertEq(vault.nonce(), 0, "a failed call must not consume the approval");

        // Once funded, the same approval goes through.
        vm.deal(address(vault), 100 ether);
        vault.execute(RECIPIENT, 100 ether, "", deadline, sigs);
        assertEq(RECIPIENT.balance, 100 ether);
    }

    // --- signing domain -------------------------------------------------------

    function test_DigestFollowsEip712() public view {
        uint256 deadline = 1_000;
        bytes memory data = hex"1234";

        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("MultisigVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(vault.EXECUTE_TYPEHASH(), RECIPIENT, 7, keccak256(data), 0, deadline)
        );

        // Off-chain signers compute this independently; it must agree exactly.
        assertEq(
            vault.hashExecute(RECIPIENT, 7, data, 0, deadline),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }
}
