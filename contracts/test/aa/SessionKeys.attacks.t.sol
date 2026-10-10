// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {SmartAccount} from "../../src/aa/SmartAccount.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SessionKeysBase} from "./SessionKeysBase.sol";

/// @dev A non-standard token that reads only what it is given: a transfer cut
///      short of its amount moves the sender's whole balance. Real tokens with
///      lax decoding exist; the cap must not depend on every token reverting.
contract LenientToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    fallback() external {
        if (msg.sig != bytes4(0xa9059cbb) || msg.data.length < 36) revert();
        address to = address(uint160(uint256(bytes32(msg.data[4:36]))));
        uint256 amount =
            msg.data.length >= 68 ? uint256(bytes32(msg.data[36:68])) : balanceOf[msg.sender];
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev One test per way a session key -- or whoever holds it -- might try to do
///      more than the owner allowed.
contract SessionKeysAttackTest is SessionKeysBase {
    address internal constant THIEF = address(0xBAD);

    function setUp() public override {
        super.setUp();
        _grantTransfers();
    }

    function _refused(PackedUserOperation memory op) internal {
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error")
        );
        _submit(op);
    }

    // --- escalating privileges ------------------------------------------------

    /// A session granting itself a bigger session, or a second key.
    function test_Attack_SessionGrantsItselfMore() public {
        SmartAccount.Permission[] memory none = new SmartAccount.Permission[](0);
        bytes memory grant = abi.encodeCall(
            SmartAccount.addSession,
            (THIEF, 0, uint48(block.timestamp + 365 days), 100 ether, none, _noCaps())
        );
        _refused(_bySession(_sessionCall(address(account), 0, grant)));
    }

    function test_Attack_SessionTakesTheAccount() public {
        _refused(
            _bySession(
                _sessionCall(
                    address(account), 0, abi.encodeCall(SmartAccount.transferOwnership, (THIEF))
                )
            )
        );
        _refused(
            _bySession(
                _sessionCall(
                    address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (THIEF))
                )
            )
        );
    }

    /// The EntryPoint holds the account's deposit; withdrawTo there would empty it.
    function test_Attack_SessionDrainsTheDepositAtTheEntryPoint() public {
        bytes memory withdraw = abi.encodeCall(IStakeManager.withdrawTo, (payable(THIEF), 1 ether));
        _refused(_bySession(_sessionCall(address(entryPoint), 0, withdraw)));
    }

    function test_Attack_SessionCallsTheRecoveryModule() public {
        address module = makeAddr("module");
        _asOwner(
            _execute(address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (module)))
        );
        _refused(_bySession(_sessionCall(module, 0, "")));
    }

    /// execute and executeBatch skip the spend accounting; they are the owner's.
    function test_Attack_SessionUsesExecuteDirectly() public {
        bytes memory transfer = abi.encodeCall(MockERC20.transfer, (THIEF, 900_000_000));
        _refused(_bySession(_execute(address(token), 0, transfer)));

        SmartAccount.Call[] memory calls = new SmartAccount.Call[](1);
        calls[0] = SmartAccount.Call(address(token), 0, transfer);
        _refused(_bySession(abi.encodeCall(SmartAccount.executeBatch, (calls))));
    }

    // --- out of scope ---------------------------------------------------------

    function test_Attack_FunctionOutsideThePermission() public {
        _refused(
            _bySession(
                _sessionCall(address(token), 0, abi.encodeCall(MockERC20.approve, (THIEF, 1)))
            )
        );
    }

    function test_Attack_TargetOutsideThePermission() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(account), 1 ether);
        _refused(
            _bySession(
                _sessionCall(address(other), 0, abi.encodeCall(MockERC20.transfer, (THIEF, 1)))
            )
        );
    }

    function test_Attack_EtherAttachedWithoutANativeLimit() public {
        // Permitted call, but with ether riding along; the native limit is zero.
        _submit(
            _bySession(
                _sessionCall(
                    address(token), 1 ether, abi.encodeCall(MockERC20.transfer, (THIEF, 1))
                )
            )
        );
        assertEq(token.balanceOf(THIEF), 0);
    }

    // --- getting round the cap ------------------------------------------------

    /// Splitting a drain into small transfers: the cap is a total, not a size.
    function test_Attack_SplittingPastTheCap() public {
        for (uint256 i; i < 10; ++i) {
            _submit(_bySession(_transfer(THIEF, 15_000_000)));
        }
        assertEq(token.balanceOf(THIEF), 90_000_000, "six fit under 100; the rest reverted");
        assertEq(_spent(), 90_000_000);
    }

    /// Two operations in one bundle. The EntryPoint validates both before it
    /// executes either, so a cap checked in validation would pass them both.
    /// Counted in execution, the second finds the first already spent.
    function test_Attack_TwoOperationsInOneBundle() public {
        PackedUserOperation memory first = _bySession(_transfer(THIEF, 60_000_000));
        // The next nonce in the session's sequence, signed before the first runs.
        PackedUserOperation memory second = _op(address(account), "", _transfer(THIEF, 60_000_000));
        second.nonce = first.nonce + 1;
        second = _signAsSession(sessionPrivateKey, second);

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        (ops[0], ops[1]) = (first, second);
        _submitAll(ops);

        assertEq(token.balanceOf(THIEF), 60_000_000);
    }

    /// A hostile bundler places the owner's revocation ahead of a session
    /// operation it already validated. Execution must notice the session is gone.
    function test_Attack_SessionUsedAfterARevocationInTheSameBundle() public {
        PackedUserOperation memory revoke = _signWith(
            ownerKey,
            _op(address(account), "", abi.encodeCall(SmartAccount.revokeSession, (sessionKey)))
        );
        PackedUserOperation memory spend = _bySession(_transfer(THIEF, 1));

        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        (ops[0], ops[1]) = (revoke, spend);
        _submitAll(ops);

        assertEq(token.balanceOf(THIEF), 0);
    }

    /// An unlimited approve would hand the whole balance to the spender,
    /// outside the cap. Approvals count against it.
    function test_Attack_ApproveCountsAgainstTheCap() public {
        SmartAccount.Condition[] memory none = _noConditions();
        SmartAccount.Permission[] memory both = new SmartAccount.Permission[](2);
        both[0] = _transferPermission(none);
        both[1] = SmartAccount.Permission(address(token), MockERC20.approve.selector, none);
        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));
        _grant(0, uint48(block.timestamp + 1 days), 0, both, _cap(CAP));

        _submit(
            _bySession(
                _sessionCall(
                    address(token), 0, abi.encodeCall(MockERC20.approve, (THIEF, type(uint256).max))
                )
            )
        );

        assertEq(token.allowance(address(account), THIEF), 0);
    }

    /// A permission that lets a capped token be moved some way the cap does not
    /// count -- transferFrom, here -- is refused at execution.
    function test_Attack_UncountedCallOnACappedToken() public {
        SmartAccount.Permission[] memory list = new SmartAccount.Permission[](1);
        list[0] = SmartAccount.Permission(
            address(token), MockERC20.transferFrom.selector, _noConditions()
        );
        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));
        _grant(0, uint48(block.timestamp + 1 days), 0, list, _cap(CAP));
        _asOwner(
            _execute(
                address(token), 0, abi.encodeCall(MockERC20.approve, (address(account), 10 ** 30))
            )
        );

        bytes memory pull =
            abi.encodeCall(MockERC20.transferFrom, (address(account), THIEF, 500_000_000));
        _submit(_bySession(_sessionCall(address(token), 0, pull)));

        assertEq(token.balanceOf(THIEF), 0);
    }

    /// A transfer cut off before its amount, to a token that tolerates it. Read
    /// past the data, the amount would come out as zero and go uncounted, while
    /// the token moves everything.
    function test_Attack_TruncatedTransferOnACappedToken() public {
        LenientToken lenient = new LenientToken();
        lenient.mint(address(account), 1_000_000_000);
        SmartAccount.Permission[] memory list = new SmartAccount.Permission[](1);
        list[0] =
            SmartAccount.Permission(address(lenient), MockERC20.transfer.selector, _noConditions());
        SmartAccount.SpendLimit[] memory limits = new SmartAccount.SpendLimit[](1);
        limits[0] = SmartAccount.SpendLimit(address(lenient), CAP);
        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));
        _grant(0, uint48(block.timestamp + 1 days), 0, list, limits);

        bytes memory truncated =
            abi.encodePacked(MockERC20.transfer.selector, bytes32(uint256(uint160(THIEF))));
        _submit(_bySession(_sessionCall(address(lenient), 0, truncated)));

        assertEq(lenient.balanceOf(THIEF), 0, "a capped token never moves uncounted");
    }

    /// The owner, by mistake, grants a permission on the account itself, the
    /// EntryPoint, or the recovery module. Those targets stay off-limits to a
    /// session whatever its permissions say.
    function test_Attack_PermissionGrantedOnAForbiddenTarget() public {
        address module = makeAddr("module");
        _asOwner(
            _execute(address(account), 0, abi.encodeCall(SmartAccount.setRecoveryModule, (module)))
        );

        SmartAccount.Permission[] memory list = new SmartAccount.Permission[](3);
        list[0] = SmartAccount.Permission(
            address(account), SmartAccount.addSession.selector, _noConditions()
        );
        list[1] = SmartAccount.Permission(
            address(entryPoint), IStakeManager.withdrawTo.selector, _noConditions()
        );
        list[2] = SmartAccount.Permission(module, bytes4(0), _noConditions());
        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));
        _grant(0, uint48(block.timestamp + 1 days), 0, list, _noCaps());

        SmartAccount.Permission[] memory none = new SmartAccount.Permission[](0);
        bytes memory grant = abi.encodeCall(
            SmartAccount.addSession,
            (THIEF, 0, uint48(block.timestamp + 365 days), 100 ether, none, _noCaps())
        );
        _refused(_bySession(_sessionCall(address(account), 0, grant)));
        bytes memory withdraw = abi.encodeCall(IStakeManager.withdrawTo, (payable(THIEF), 1));
        _refused(_bySession(_sessionCall(address(entryPoint), 0, withdraw)));
        _refused(_bySession(_sessionCall(module, 0, "")));
    }

    // --- signatures and outsiders ---------------------------------------------

    /// The session key of one account used on another account of the same owner.
    function test_Attack_SessionKeyOnAnotherAccount() public {
        vm.deal(factory.getAddress(owner, 1), 1 ether);
        SmartAccount other = _deployAndCall(1, RECIPIENT, 0, "");
        PackedUserOperation memory op = _op(address(other), "", _transfer(THIEF, 1));
        _refused(_signAsSession(sessionPrivateKey, op));

        // Nor as if it were the other account's owner.
        _refused(_signWith(sessionPrivateKey, _op(address(other), "", _transfer(THIEF, 1))));
    }

    /// A session's signature without the address in front reads as the
    /// owner's, and the session key is not the owner.
    function test_Attack_SessionSignatureWithoutItsAddress() public {
        PackedUserOperation memory op = _op(address(account), "", _transfer(THIEF, 1));
        op.nonce = entryPoint.getNonce(address(account), uint192(uint160(sessionKey)));
        _refused(_signWith(sessionPrivateKey, op));
    }

    function test_Attack_SignatureOfAnyOtherLength() public {
        PackedUserOperation memory op = _bySession(_transfer(THIEF, 1));
        bytes memory longer = bytes.concat(op.signature, hex"00");
        op.signature = longer;
        _refused(op);

        op = _bySession(_transfer(THIEF, 1));
        bytes memory shorter = new bytes(84);
        for (uint256 i; i < 84; ++i) {
            shorter[i] = op.signature[i];
        }
        op.signature = shorter;
        _refused(op);
    }

    function test_Attack_StrangerSignsAsASession() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        _refused(_sessionOp(_transfer(THIEF, 1), strangerKey));
    }

    function test_Attack_OutsiderManagesSessions() public {
        SmartAccount.Permission[] memory none = new SmartAccount.Permission[](0);
        vm.startPrank(THIEF);
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.addSession(THIEF, 0, uint48(block.timestamp + 1), 0, none, _noCaps());
        vm.expectRevert(SmartAccount.OnlyEntryPoint.selector);
        account.revokeSession(sessionKey);
        vm.stopPrank();
    }

    /// A permission for plain ether (selector 0) must not also admit a call
    /// with a few stray bytes of data, which would reach the target as a call.
    function test_Attack_StrayBytesPassedOffAsPlainEther() public {
        SmartAccount.Permission[] memory list = new SmartAccount.Permission[](1);
        list[0] = SmartAccount.Permission(THIEF, bytes4(0), _noConditions());
        _asOwner(abi.encodeCall(SmartAccount.revokeSession, (sessionKey)));
        _grant(0, uint48(block.timestamp + 1 days), 1 ether, list, _noCaps());

        _refused(_bySession(_sessionCall(THIEF, 0, hex"0000")));
    }

    function test_Attack_MalformedSessionCallData() public {
        _refused(_bySession(hex"deadbeef"));
        _refused(_bySession(hex"00"));
    }
}
