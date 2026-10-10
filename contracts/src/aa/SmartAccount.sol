// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title A user's own ERC-4337 account.
/// @notice A contract that is a wallet. The user signs UserOperations; a bundler
///         submits them to the EntryPoint, which asks this account whether the
///         signature is good before letting it act. Nobody else -- the platform
///         included -- can move what it holds.
/// @dev Written against EntryPoint v0.8, where the userOpHash is an EIP-712
///      digest over the operation, the EntryPoint and the chain. That binding
///      is what makes a signature worthless on any other chain, EntryPoint or
///      account; the owner signs the digest as it is, with no message prefix.
///
///      Deliberately not upgradeable. An upgrade path is a second way to take
///      the account over, and the owner can always move funds to a new one.
contract SmartAccount is IAccount, IAccountExecute {
    /// @dev ERC-4337's verdicts. A bad signature is reported, not reverted, so
    ///      a bundler simulating the operation -- or estimating its gas with a
    ///      placeholder signature -- gets an answer rather than an error.
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    IEntryPoint public immutable entryPoint;
    address public owner;

    /// @notice The one contract, besides the account itself, allowed to replace
    ///         the owner -- the guardians' recovery module. Zero means none.
    /// @dev Deliberately not a general module system. A module that could make
    ///      the account call anything would be a second owner; this one can do
    ///      exactly one thing, and only what the owner chose to allow.
    address public recoveryModule;

    // --- session keys -----------------------------------------------------------
    //
    // A session key is a second key the owner hands to an app or a bot, bounded
    // in time, in what it may call -- down to the arguments -- and in how much it
    // may move. Leaking one costs at most what its limits allow.
    //
    // Everything about a session lives in this account's own storage. ERC-7562
    // lets validation read the sender's own storage freely; a separate module's
    // nested mapping(account => mapping(key => ...)) would not qualify as
    // storage "associated" with the sender, and real bundlers would refuse the
    // operation.

    enum Operator {
        Equal,
        LessOrEqual,
        GreaterOrEqual
    }

    /// @notice A rule on one 32-byte argument of the call: the `param`-th word
    ///         after the selector, compared as an unsigned number (or, for
    ///         Equal, as raw bytes -- addresses included).
    struct Condition {
        uint8 param;
        Operator operator;
        bytes32 value;
    }

    /// @notice One call shape a session may make: this target, this function,
    ///         and every condition true.
    struct Permission {
        address target;
        bytes4 selector;
        Condition[] conditions;
    }

    /// @notice A token the session may move only so much of, in total. Counted on
    ///         transfer and approve -- an unlimited approve would otherwise move
    ///         the cap to whoever was approved -- and any other call to a capped
    ///         token is refused, so nothing moves it uncounted.
    struct SpendLimit {
        address token;
        uint256 limit;
    }

    struct Session {
        bool active;
        uint48 validAfter;
        uint48 validUntil;
        uint256 nativeLimit;
        uint256 nativeSpent;
    }

    struct TokenAllowance {
        bool capped;
        uint256 limit;
        uint256 spent;
    }

    mapping(address key => Session) public sessions;
    mapping(address key => Permission[]) private _permissions;
    mapping(address key => mapping(address token => TokenAllowance)) public tokenAllowances;
    mapping(address key => address[]) private _cappedTokens;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event SessionAdded(address indexed key, uint48 validAfter, uint48 validUntil);
    event SessionRevoked(address indexed key);
    event RecoveryModuleChanged(address indexed module);

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error OnlyEntryPoint();
    error OnlyOwnerOrRecovery();
    error InvalidOwner();
    error CallFailed(uint256 index, bytes returndata);
    error InvalidSessionKey(address key);
    error SessionExists(address key);
    error InvalidValidity(uint48 validAfter, uint48 validUntil);
    error SessionInactive(address key);
    error NativeLimitExceeded(uint256 spent, uint256 limit);
    error TokenLimitExceeded(address token, uint256 spent, uint256 limit);
    error UncountedTokenCall(address token, bytes4 selector);

    constructor(IEntryPoint entryPoint_, address owner_) {
        // A malformed signature recovers to the zero address. With the zero
        // address as owner, a single missed error check would hand the account
        // to anyone who sends garbage.
        if (owner_ == address(0)) revert InvalidOwner();
        entryPoint = entryPoint_;
        owner = owner_;
    }

    receive() external payable {}

    /// @dev Only the EntryPoint can make the account act, and only after it has
    ///      validated a UserOperation. The account may also call itself, which
    ///      is how later phases will change its own settings through a signed
    ///      operation.
    modifier onlyEntryPointOrSelf() {
        if (msg.sender != address(entryPoint) && msg.sender != address(this)) {
            revert OnlyEntryPoint();
        }
        _;
    }

    /// @inheritdoc IAccount
    /// @dev Must not revert over a bad signature, and must pay what it owes the
    ///      EntryPoint for gas even when it has no deposit there. Nonces are the
    ///      EntryPoint's job: it rejects a replayed operation before asking.
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        validationData = _validateSigner(userOp, userOpHash);

        if (missingAccountFunds != 0) {
            // The EntryPoint verifies it was paid; a failed transfer here only
            // means the operation is rejected there.
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (paid);
        }
    }

    /// @dev Signature layouts:
    ///
    ///        65 bytes  the owner's ECDSA signature
    ///        85 bytes  a session key's address, then its ECDSA signature
    ///
    ///      The session's address travels in the signature rather than being
    ///      recovered from it, so execution knows which session to charge
    ///      without recovering again. That matters for gas estimation: a bundler
    ///      simulates the operation with a placeholder signature, which recovers
    ///      to nobody -- and a session recovered in execution would then be no
    ///      session at all, and the simulation would revert. With the address
    ///      stated, execution charges the right session whatever the signature;
    ///      and nothing reaches execution unless validation found the signature
    ///      really is that session's.
    ///
    ///      The verdict: the owner may do anything; a live session key only what
    ///      its permissions allow, inside its validity window, which goes back
    ///      to the EntryPoint to enforce. ERC-7562 bars validation from reading
    ///      the clock, so the window is never compared here.
    function _validateSigner(PackedUserOperation calldata userOp, bytes32 userOpHash)
        private
        view
        returns (uint256)
    {
        bytes calldata signature = userOp.signature;
        if (signature.length == 65) {
            // tryRecover, not recover: a malformed or malleable signature must
            // come back as a failure verdict rather than a revert.
            (address signer, ECDSA.RecoverError recoverError,) =
                ECDSA.tryRecover(userOpHash, signature);
            return recoverError == ECDSA.RecoverError.NoError && signer == owner
                ? SIG_VALIDATION_SUCCESS
                : SIG_VALIDATION_FAILED;
        }
        if (signature.length != 85) return SIG_VALIDATION_FAILED;

        address key = address(bytes20(signature[:20]));
        (address recovered, ECDSA.RecoverError keyError,) =
            ECDSA.tryRecover(userOpHash, signature[20:]);
        if (keyError != ECDSA.RecoverError.NoError || recovered != key) {
            return SIG_VALIDATION_FAILED;
        }

        Session storage session = sessions[key];
        if (!session.active) return SIG_VALIDATION_FAILED;

        // A session acts only through executeUserOp, which hands the whole
        // operation to execution so the spend can be counted against the key
        // that signed it. execute and executeBatch are the owner's.
        bytes calldata callData = userOp.callData;
        if (callData.length < 4 || bytes4(callData[:4]) != this.executeUserOp.selector) {
            return SIG_VALIDATION_FAILED;
        }
        (address target,, bytes memory data) = abi.decode(callData[4:], (address, uint256, bytes));

        // Never the account's own settings, the EntryPoint (deposits, nonces)
        // or the recovery module: each would let a session grant itself more.
        if (target == address(this) || target == address(entryPoint) || target == recoveryModule) {
            return SIG_VALIDATION_FAILED;
        }
        if (!_permitted(key, target, data)) return SIG_VALIDATION_FAILED;

        return (uint256(session.validUntil) << 160) | (uint256(session.validAfter) << 208);
    }

    function _permitted(address key, address target, bytes memory data)
        private
        view
        returns (bool)
    {
        // Plain ether, with no call data, is the selector 0x00000000: a session
        // can be allowed to send ether to one address and nothing else.
        bytes4 selector;
        if (data.length >= 4) {
            // forge-lint: disable-next-line(unsafe-typecast)
            selector = bytes4(data); // keeps the first four bytes, which exist
        } else if (data.length != 0) {
            return false;
        }
        Permission[] storage permissions = _permissions[key];

        for (uint256 i; i < permissions.length; ++i) {
            Permission storage permission = permissions[i];
            if (permission.target != target || permission.selector != selector) continue;
            if (_conditionsHold(permission.conditions, data)) return true;
        }
        return false;
    }

    function _conditionsHold(Condition[] storage conditions, bytes memory data)
        private
        view
        returns (bool)
    {
        for (uint256 i; i < conditions.length; ++i) {
            Condition storage condition = conditions[i];
            uint256 offset = 4 + 32 * uint256(condition.param);
            // An argument the call does not carry cannot satisfy a rule about it.
            if (data.length < offset + 32) return false;
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(data, 32), offset))
            }
            if (condition.operator == Operator.Equal) {
                if (word != condition.value) return false;
            } else if (condition.operator == Operator.LessOrEqual) {
                if (uint256(word) > uint256(condition.value)) return false;
            } else if (uint256(word) < uint256(condition.value)) {
                return false;
            }
        }
        return true;
    }

    /// @inheritdoc IAccountExecute
    /// @notice Runs a call the EntryPoint validated, with the whole operation in
    ///         hand. A session's spending is counted here, in execution: an
    ///         operation over its limit reverts, though the gas for trying is
    ///         spent.
    /// @dev The session is read from the operation's own signature, not
    ///      remembered from validation. The EntryPoint validates every operation
    ///      in a bundle before executing any, so a "current session" left in
    ///      storage could be overwritten by the next operation's validation
    ///      before this one runs -- and a hostile bundler could arrange exactly
    ///      that. A 65-byte signature is the owner's, and is never charged.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32) external {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        (address target, uint256 value, bytes memory data) =
            abi.decode(userOp.callData[4:], (address, uint256, bytes));

        if (userOp.signature.length == 85) {
            _charge(address(bytes20(userOp.signature[:20])), target, value, data);
        }

        (bool ok, bytes memory returndata) = target.call{value: value}(data);
        if (!ok) revert CallFailed(0, returndata);
    }

    function _charge(address key, address target, uint256 value, bytes memory data) private {
        Session storage session = sessions[key];
        // Revoked by an operation executed earlier in the same bundle.
        if (!session.active) revert SessionInactive(key);

        if (value != 0) {
            uint256 nativeSpent = session.nativeSpent + value;
            if (nativeSpent > session.nativeLimit) {
                revert NativeLimitExceeded(nativeSpent, session.nativeLimit);
            }
            session.nativeSpent = nativeSpent;
        }

        TokenAllowance storage allowance = tokenAllowances[key][target];
        if (!allowance.capped) return;

        // A transfer or approve cut short of its amount would leave the amount
        // read from beyond the data -- typically zero, so uncounted. A token
        // that tolerated the short call would then move funds for free.
        if (data.length < 68) revert UncountedTokenCall(target, bytes4(0));
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data); // at least 68 bytes, checked above
        if (selector != bytes4(0xa9059cbb) && selector != bytes4(0x095ea7b3)) {
            // transfer(address,uint256) and approve(address,uint256) are the
            // only ways a capped token moves under a session, so that every
            // amount is counted.
            revert UncountedTokenCall(target, selector);
        }
        uint256 amount;
        assembly ("memory-safe") {
            amount := mload(add(data, 68))
        }
        uint256 spent = allowance.spent + amount;
        if (spent > allowance.limit) revert TokenLimitExceeded(target, spent, allowance.limit);
        allowance.spent = spent;
    }

    // --- managing sessions: only the owner, through a signed operation ---------

    function addSession(
        address key,
        uint48 validAfter,
        uint48 validUntil,
        uint256 nativeLimit,
        Permission[] calldata permissions,
        SpendLimit[] calldata limits
    ) external onlyEntryPointOrSelf {
        if (key == address(0) || key == owner) {
            revert InvalidSessionKey(key);
        }
        if (sessions[key].active) revert SessionExists(key);
        // A session must expire: ERC-4337 reads validUntil 0 as "forever".
        if (validUntil == 0 || validUntil <= validAfter) {
            revert InvalidValidity(validAfter, validUntil);
        }

        sessions[key] = Session(true, validAfter, validUntil, nativeLimit, 0);
        for (uint256 i; i < permissions.length; ++i) {
            Permission storage stored = _permissions[key].push();
            stored.target = permissions[i].target;
            stored.selector = permissions[i].selector;
            for (uint256 j; j < permissions[i].conditions.length; ++j) {
                stored.conditions.push(permissions[i].conditions[j]);
            }
        }
        for (uint256 i; i < limits.length; ++i) {
            tokenAllowances[key][limits[i].token] = TokenAllowance(true, limits[i].limit, 0);
            _cappedTokens[key].push(limits[i].token);
        }
        emit SessionAdded(key, validAfter, validUntil);
    }

    /// @notice Ends a session at once, and clears everything it was allowed, so
    ///         re-adding the same key later starts from nothing.
    function revokeSession(address key) external onlyEntryPointOrSelf {
        if (!sessions[key].active) revert SessionInactive(key);
        delete sessions[key];
        delete _permissions[key];
        address[] storage capped = _cappedTokens[key];
        for (uint256 i; i < capped.length; ++i) {
            delete tokenAllowances[key][capped[i]];
        }
        delete _cappedTokens[key];
        emit SessionRevoked(key);
    }

    function permissionsOf(address key) external view returns (Permission[] memory) {
        return _permissions[key];
    }

    /// @notice Chooses -- or with zero, removes -- the recovery module. Only the
    ///         owner can, through a signed operation.
    function setRecoveryModule(address module) external onlyEntryPointOrSelf {
        recoveryModule = module;
        emit RecoveryModuleChanged(module);
    }

    /// @notice Replaces the owner. The owner may rotate its own key through a
    ///         signed operation; the recovery module may do it when the key is
    ///         lost. Nobody else, the EntryPoint included: a signed operation
    ///         reaches here only as the account calling itself.
    function transferOwnership(address newOwner) external {
        // With no module set, recoveryModule is zero, and no caller is zero.
        if (msg.sender != address(this) && msg.sender != recoveryModule) {
            revert OnlyOwnerOrRecovery();
        }
        if (newOwner == address(0)) revert InvalidOwner();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyEntryPointOrSelf
    {
        _call(0, target, value, data);
    }

    /// @notice Several calls in one operation, all or nothing -- an approve and
    ///         the transfer it allows, say.
    function executeBatch(Call[] calldata calls) external onlyEntryPointOrSelf {
        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(uint256 index, address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory returndata) = target.call{value: value}(data);
        if (!ok) revert CallFailed(index, returndata);
    }
}
