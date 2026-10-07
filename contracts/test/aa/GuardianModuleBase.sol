// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {GuardianModule} from "../../src/aa/GuardianModule.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {SmartAccountBase} from "./SmartAccountBase.sol";

/// @dev A deployed account that has, through its own signed operation, named
///      the guardian module and registered five guardians with a quorum of
///      three. Guardians are sorted by address, each key at its owner's index.
abstract contract GuardianModuleBase is SmartAccountBase {
    GuardianModule internal module;
    SmartAccount internal account;

    uint256 internal constant GUARDIAN_COUNT = 5;
    uint256 internal constant QUORUM = 3;

    address[] internal guardians;
    uint256[] internal guardianKeys;

    function setUp() public virtual override {
        super.setUp();
        module = new GuardianModule();

        for (uint256 i; i < GUARDIAN_COUNT; ++i) {
            (address guardian, uint256 key) =
                makeAddrAndKey(string.concat("guardian", vm.toString(i)));
            guardians.push(guardian);
            guardianKeys.push(key);
        }
        for (uint256 i = 1; i < guardians.length; ++i) {
            for (uint256 j = i; j > 0 && guardians[j - 1] > guardians[j]; --j) {
                (guardians[j - 1], guardians[j]) = (guardians[j], guardians[j - 1]);
                (guardianKeys[j - 1], guardianKeys[j]) = (guardianKeys[j], guardianKeys[j - 1]);
            }
        }

        vm.deal(factory.getAddress(owner, 0), 10 ether);
        account = _deployAndCall(0, RECIPIENT, 0, "");
        _asOwner(_configureRecovery(guardians, QUORUM));
    }

    /// @dev Both steps in one operation: name the module, register guardians.
    function _configureRecovery(address[] memory set, uint256 quorum)
        internal
        view
        returns (bytes memory)
    {
        SmartAccount.Call[] memory calls = new SmartAccount.Call[](2);
        calls[0] = SmartAccount.Call(
            address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (address(module)))
        );
        calls[1] = SmartAccount.Call(
            address(module), 0, abi.encodeCall(GuardianModule.setGuardians, (set, quorum))
        );
        return abi.encodeCall(SmartAccount.executeBatch, (calls));
    }

    /// @dev Signs and submits an operation with whatever key currently owns the account.
    function _asOwnerWith(uint256 key, bytes memory callData) internal {
        _submit(_signWith(key, _op(address(account), "", callData)));
    }

    function _asOwner(bytes memory callData) internal {
        _asOwnerWith(ownerKey, callData);
    }

    function _signDigest(bytes32 digest, uint256[3] memory indices)
        internal
        view
        returns (bytes[] memory sigs)
    {
        sigs = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianKeys[indices[i]], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }

    /// @dev A quorum of the three lowest guardians approving `newOwner` now.
    function _approvals(address newOwner, uint256 deadline) internal view returns (bytes[] memory) {
        bytes32 digest = module.hashRecovery(
            address(account), newOwner, module.nonce(address(account)), deadline
        );
        return _signDigest(digest, [uint256(0), 1, 2]);
    }

    function _startRecovery(address newOwner) internal {
        uint256 deadline = block.timestamp + 1 hours;
        module.initiateRecovery(
            address(account), newOwner, deadline, _approvals(newOwner, deadline)
        );
    }
}
