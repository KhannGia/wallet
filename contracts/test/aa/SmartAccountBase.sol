// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {AccountFactory} from "../../src/aa/AccountFactory.sol";
import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @dev A real EntryPoint v0.8 and the factory, plus helpers to build, sign and
///      submit UserOperations the way a bundler would -- minus the bundler.
abstract contract SmartAccountBase is Test {
    EntryPoint internal entryPoint;
    AccountFactory internal factory;
    MockERC20 internal token;

    address internal owner;
    uint256 internal ownerKey;

    /// @dev Stands in for the bundler: it submits handleOps and is repaid the gas.
    address payable internal bundler = payable(address(0xB0DE));
    address internal constant RECIPIENT = address(0xB0B);

    function setUp() public virtual {
        entryPoint = new EntryPoint();
        factory = new AccountFactory(entryPoint);
        token = new MockERC20("Mock USD Coin", "USDC", 6);
        (owner, ownerKey) = makeAddrAndKey("owner");
    }

    function _initCode(address owner_, uint256 salt) internal view returns (bytes memory) {
        return abi.encodePacked(
            address(factory), abi.encodeCall(AccountFactory.createAccount, (owner_, salt))
        );
    }

    /// @dev Generous fixed gas limits: these tests are about who may do what,
    ///      not about gas estimation, which is the bundler's job.
    function _op(address sender, bytes memory initCode, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = entryPoint.getNonce(sender, 0);
        op.initCode = initCode;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(1_000_000) << 128) | uint256(500_000));
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
    }

    function _signWith(uint256 key, PackedUserOperation memory op)
        internal
        view
        returns (PackedUserOperation memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, entryPoint.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _submit(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        // As a bundler does: an externally owned account sends the batch.
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, bundler);
    }

    function _execute(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SmartAccount.execute, (target, value, data));
    }

    /// @dev The owner's first operation: deploys the account and makes one call.
    function _deployAndCall(uint256 salt, address target, uint256 value, bytes memory data)
        internal
        returns (SmartAccount account)
    {
        address predicted = factory.getAddress(owner, salt);
        _submit(
            _signWith(
                ownerKey, _op(predicted, _initCode(owner, salt), _execute(target, value, data))
            )
        );
        account = SmartAccount(payable(predicted));
    }
}
