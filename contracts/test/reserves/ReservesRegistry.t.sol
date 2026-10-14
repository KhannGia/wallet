// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";

import {ReservesRegistry} from "../../src/reserves/ReservesRegistry.sol";

contract ReservesRegistryTest is Test {
    ReservesRegistry internal registry;
    address internal publisher = makeAddr("publisher");
    address internal token = makeAddr("token");

    bytes32 internal constant ROOT_A = keccak256("root a");
    bytes32 internal constant ROOT_B = keccak256("root b");

    function setUp() public {
        registry = new ReservesRegistry(publisher, token);
        vm.roll(100);
        vm.warp(1_000_000);
    }

    function _publish(bytes32 root, uint256 liabilities, uint256 assets, uint64 blockNumber)
        internal
        returns (uint256)
    {
        vm.prank(publisher);
        return registry.publish(root, liabilities, assets, blockNumber);
    }

    function test_RecordsWhoPublishesAndInWhichToken() public view {
        assertEq(registry.publisher(), publisher);
        assertEq(registry.token(), token);
        assertEq(registry.count(), 0);
    }

    function test_RecordsAnAttestationAndAnnouncesIt() public {
        vm.expectEmit(address(registry));
        emit ReservesRegistry.Published(0, ROOT_A, 7_000, 9_000, 42);
        assertEq(_publish(ROOT_A, 7_000, 9_000, 42), 0);

        ReservesRegistry.Attestation memory stored = registry.attestation(0);
        assertEq(stored.root, ROOT_A);
        assertEq(stored.liabilities, 7_000);
        assertEq(stored.assets, 9_000);
        assertEq(stored.blockNumber, 42);
        assertEq(stored.publishedAt, 1_000_000);
        assertEq(registry.count(), 1);
    }

    function test_NumbersAttestationsInOrderAndFindsTheLatest() public {
        _publish(ROOT_A, 1, 1, 10);
        assertEq(_publish(ROOT_B, 2, 3, 20), 1);

        (uint256 id, ReservesRegistry.Attestation memory last) = registry.latest();
        assertEq(id, 1);
        assertEq(last.root, ROOT_B);
        assertEq(last.assets, 3);
    }

    /// What a user's verifier does with the root in their proof.
    function test_FindsAnAttestationByItsRoot() public {
        _publish(ROOT_A, 1, 1, 10);
        _publish(ROOT_B, 2, 2, 20);

        (uint256 id, ReservesRegistry.Attestation memory found) = registry.findByRoot(ROOT_A);
        assertEq(id, 0);
        assertEq(found.liabilities, 1);

        (id,) = registry.findByRoot(ROOT_B);
        assertEq(id, 1);
    }

    /// An empty tree always has the same root; looking it up finds the latest.
    function test_ARepeatedRootResolvesToItsLatestAttestation() public {
        _publish(ROOT_A, 0, 0, 10);
        _publish(ROOT_B, 5, 5, 20);
        _publish(ROOT_A, 0, 3, 30);

        (uint256 id, ReservesRegistry.Attestation memory found) = registry.findByRoot(ROOT_A);
        assertEq(id, 2);
        assertEq(found.assets, 3);
    }

    /// Balances move between users with no new block, so the same block may
    /// be attested twice.
    function test_AcceptsTheSameBlockAgain() public {
        _publish(ROOT_A, 1, 1, 50);
        assertEq(_publish(ROOT_B, 2, 2, 50), 1);
    }

    function test_AcceptsTheBlockJustBeforeTheCurrentOne() public {
        assertEq(_publish(ROOT_A, 1, 1, 99), 0);
    }

    function test_RevertWhen_ConstructedWithoutAPublisherOrToken() public {
        vm.expectRevert(ReservesRegistry.ZeroAddress.selector);
        new ReservesRegistry(address(0), token);
        vm.expectRevert(ReservesRegistry.ZeroAddress.selector);
        new ReservesRegistry(publisher, address(0));
    }

    function test_RevertWhen_AnyoneElsePublishes() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.NotPublisher.selector, stranger));
        registry.publish(ROOT_A, 1, 1, 10);
    }

    function test_RevertWhen_TheRootIsEmpty() public {
        vm.prank(publisher);
        vm.expectRevert(ReservesRegistry.EmptyRoot.selector);
        registry.publish(bytes32(0), 1, 1, 10);
    }

    /// Balances cannot have been read at a block that is not yet on chain.
    function test_RevertWhen_TheBlockIsNotInThePast() public {
        vm.startPrank(publisher);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.NotInThePast.selector, 100, 100));
        registry.publish(ROOT_A, 1, 1, 100);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.NotInThePast.selector, 500, 100));
        registry.publish(ROOT_A, 1, 1, 500);
        vm.stopPrank();
    }

    /// The record reads forwards: an attestation cannot be slipped in before
    /// one already published, to stand in for it.
    function test_RevertWhen_TheBlockGoesBackwards() public {
        _publish(ROOT_A, 1, 1, 50);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.BeforePrevious.selector, 49, 50));
        registry.publish(ROOT_B, 1, 1, 49);
    }

    function test_RevertWhen_LookingUpWhatWasNeverPublished() public {
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.UnknownAttestation.selector, 0));
        registry.latest();
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.UnknownAttestation.selector, 0));
        registry.attestation(0);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.UnknownRoot.selector, ROOT_A));
        registry.findByRoot(ROOT_A);

        _publish(ROOT_A, 1, 1, 10);
        vm.expectRevert(abi.encodeWithSelector(ReservesRegistry.UnknownAttestation.selector, 1));
        registry.attestation(1);
    }

    /// However many are published, each reads back exactly as written.
    function testFuzz_KeepsEveryAttestationAsWritten(uint8 n, uint256 seed) public {
        uint256 total = bound(n, 1, 20);
        vm.roll(1_000);
        for (uint256 i; i < total; ++i) {
            bytes32 root = keccak256(abi.encode(seed, i));
            _publish(root, seed ^ i, i, uint64(i * 10));
        }
        assertEq(registry.count(), total);
        for (uint256 i; i < total; ++i) {
            ReservesRegistry.Attestation memory stored = registry.attestation(i);
            assertEq(stored.root, keccak256(abi.encode(seed, i)));
            assertEq(stored.liabilities, seed ^ i);
            assertEq(stored.blockNumber, i * 10);
        }
    }
}
