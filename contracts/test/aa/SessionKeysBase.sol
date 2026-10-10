// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SmartAccountBase} from "./SmartAccountBase.sol";

/// @dev A deployed account holding ether and tokens, a session key, and helpers
///      to grant permissions and to send operations the way an app holding only
///      the session key would.
abstract contract SessionKeysBase is SmartAccountBase {
    SmartAccount internal account;
    address internal sessionKey;
    uint256 internal sessionPrivateKey;

    uint256 internal constant CAP = 100_000_000; // 100 USDC

    function setUp() public virtual override {
        super.setUp();
        (sessionKey, sessionPrivateKey) = makeAddrAndKey("session");
        vm.deal(factory.getAddress(owner, 0), 10 ether);
        token.mint(factory.getAddress(owner, 0), 1_000_000_000);
        account = _deployAndCall(0, RECIPIENT, 0, "");
    }

    // --- building permissions -------------------------------------------------

    function _transferPermission(SmartAccount.Condition[] memory conditions)
        internal
        view
        returns (SmartAccount.Permission memory)
    {
        return SmartAccount.Permission(address(token), MockERC20.transfer.selector, conditions);
    }

    function _noConditions() internal pure returns (SmartAccount.Condition[] memory) {
        return new SmartAccount.Condition[](0);
    }

    function _one(SmartAccount.Permission memory permission)
        internal
        pure
        returns (SmartAccount.Permission[] memory list)
    {
        list = new SmartAccount.Permission[](1);
        list[0] = permission;
    }

    function _cap(uint256 limit) internal view returns (SmartAccount.SpendLimit[] memory limits) {
        limits = new SmartAccount.SpendLimit[](1);
        limits[0] = SmartAccount.SpendLimit(address(token), limit);
    }

    function _noCaps() internal pure returns (SmartAccount.SpendLimit[] memory) {
        return new SmartAccount.SpendLimit[](0);
    }

    // --- operations -----------------------------------------------------------

    function _asOwner(bytes memory callData) internal {
        _submit(_signWith(ownerKey, _op(address(account), "", callData)));
    }

    /// @dev The owner grants a session through a signed operation.
    function _grant(
        uint48 validAfter,
        uint48 validUntil,
        uint256 nativeLimit,
        SmartAccount.Permission[] memory permissions,
        SmartAccount.SpendLimit[] memory limits
    ) internal {
        _asOwner(
            abi.encodeCall(
                SmartAccount.addSession,
                (sessionKey, validAfter, validUntil, nativeLimit, permissions, limits)
            )
        );
    }

    /// @dev A 24-hour session that may transfer the token to anyone, capped.
    function _grantTransfers() internal {
        _grant(
            0,
            uint48(block.timestamp + 24 hours),
            0,
            _one(_transferPermission(_noConditions())),
            _cap(CAP)
        );
    }

    function _sessionCall(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(SmartAccount.executeUserOp.selector, abi.encode(target, value, data));
    }

    /// @dev Sessions use their own nonce key, so an app's operations never hold
    ///      up the owner's. The signature names the session it claims to be --
    ///      `sessionKey` -- then carries the signature of whichever key signs.
    function _sessionOp(bytes memory callData, uint256 key)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _op(address(account), "", callData);
        op.nonce = entryPoint.getNonce(address(account), uint192(uint160(sessionKey)));
        return _signAsSession(key, op);
    }

    function _signAsSession(uint256 key, PackedUserOperation memory op)
        internal
        view
        returns (PackedUserOperation memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, entryPoint.getUserOpHash(op));
        op.signature = abi.encodePacked(sessionKey, r, s, v);
        return op;
    }

    function _bySession(bytes memory callData) internal view returns (PackedUserOperation memory) {
        return _sessionOp(callData, sessionPrivateKey);
    }

    function _transfer(address to, uint256 amount) internal view returns (bytes memory) {
        return _sessionCall(address(token), 0, abi.encodeCall(MockERC20.transfer, (to, amount)));
    }

    function _submitAll(PackedUserOperation[] memory ops) internal {
        vm.prank(bundler, bundler);
        entryPoint.handleOps(ops, bundler);
    }

    function _spent() internal view returns (uint256 spent) {
        (,, spent) = account.tokenAllowances(sessionKey, address(token));
    }
}
