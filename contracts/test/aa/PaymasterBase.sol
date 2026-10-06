// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {VerifyingPaymaster} from "../../src/aa/VerifyingPaymaster.sol";
import {SmartAccountBase} from "./SmartAccountBase.sol";

/// @dev A funded, staked paymaster on a real EntryPoint, and helpers to attach
///      a sponsorship to an operation in the order a wallet does it: the
///      sponsor signs first, then the account signs the whole operation --
///      paymasterAndData included -- last.
abstract contract PaymasterBase is SmartAccountBase {
    VerifyingPaymaster internal paymaster;
    address internal sponsor;
    uint256 internal sponsorKey;
    address internal paymasterOwner = makeAddr("paymasterOwner");

    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 100_000;

    function setUp() public virtual override {
        super.setUp();
        (sponsor, sponsorKey) = makeAddrAndKey("sponsor");
        paymaster = new VerifyingPaymaster(entryPoint, sponsor, paymasterOwner);

        vm.deal(paymasterOwner, 20 ether);
        vm.startPrank(paymasterOwner);
        paymaster.deposit{value: 10 ether}();
        paymaster.addStake{value: 1 ether}(1 days);
        vm.stopPrank();
    }

    /// @dev The paymaster's address and gas limits, without the sponsorship.
    ///      The sponsor signs over the gas limits, so they must be in place
    ///      before the signature is made.
    function _gasPrefix(VerifyingPaymaster target) internal pure returns (bytes memory) {
        return abi.encodePacked(address(target), PAYMASTER_VERIFICATION_GAS, uint128(0));
    }

    function _sponsorWith(
        VerifyingPaymaster target,
        uint256 key,
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter
    ) internal view returns (PackedUserOperation memory) {
        op.paymasterAndData = _gasPrefix(target);
        bytes32 digest = target.hashSponsorship(op, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData =
            abi.encodePacked(_gasPrefix(target), validUntil, validAfter, abi.encodePacked(r, s, v));
        return op;
    }

    /// @dev A sponsorship from the real sponsor, valid for the next hour.
    function _sponsored(PackedUserOperation memory op)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _sponsorWith(paymaster, sponsorKey, op, uint48(block.timestamp + 1 hours), 0);
    }
}
