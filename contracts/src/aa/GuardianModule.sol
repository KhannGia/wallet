// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {SmartAccount} from "./SmartAccount.sol";

/// @title Social recovery for SmartAccounts.
/// @notice An owner who loses their key is not locked out for good: a quorum of
///         guardians they chose in advance can hand the account to a new key.
///         Not at once, though. A recovery waits RECOVERY_DELAY, during which
///         the owner -- if the key was never lost, and the guardians are
///         colluding -- or a quorum of guardians can cancel it.
/// @dev One deployment serves every account. An account opts in by naming this
///      contract its recovery module and registering guardians here, both
///      through its own signed operations, so every call that configures an
///      account comes from that account.
///
///      Guardians approve off-chain with EIP-712 signatures, collected and
///      submitted by anyone, so a guardian needs no ether -- the same pattern,
///      and the same rules, as the multisig vault: exactly `threshold`
///      signatures, strictly ascending by signer.
///
///      Recovery protects against a lost key, not a stolen one. A thief with the
///      key can move the funds at once, without waiting for anybody.
contract GuardianModule is EIP712 {
    uint256 public constant RECOVERY_DELAY = 48 hours;

    /// @notice A recovery not executed within this long after it matures
    ///         lapses, so an old approval cannot be executed long afterwards.
    uint256 public constant EXECUTION_WINDOW = 7 days;

    uint256 public constant MAX_GUARDIANS = 10;

    bytes32 public constant RECOVERY_TYPEHASH =
        keccak256("Recovery(address account,address newOwner,uint256 nonce,uint256 deadline)");
    bytes32 public constant CANCEL_TYPEHASH =
        keccak256("CancelRecovery(address account,uint256 nonce,uint256 deadline)");

    struct Pending {
        address newOwner;
        uint64 executableAt;
    }

    mapping(address account => address[]) private _guardians;
    mapping(address account => mapping(address guardian => bool)) public isGuardian;
    mapping(address account => uint256) public threshold;

    /// @notice Spent by every recovery started or cancelled, and by every change
    ///         of guardians, so each approval is good for exactly one of them.
    mapping(address account => uint256) public nonce;

    mapping(address account => Pending) public pending;

    event GuardiansChanged(address indexed account, address[] guardians, uint256 threshold);
    event RecoveryStarted(address indexed account, address indexed newOwner, uint256 executableAt);
    event RecoveryCancelled(address indexed account, address indexed by);
    event RecoveryExecuted(address indexed account, address indexed newOwner);

    error InvalidThreshold(uint256 threshold, uint256 guardianCount);
    error InvalidGuardian(address guardian);
    error DuplicateGuardian(address guardian);
    error NotRecoveryModule(address account);
    error InvalidNewOwner(address newOwner);
    error RecoveryPending(address account);
    error NoRecoveryPending(address account);
    error NotReady(uint256 executableAt, uint256 timestamp);
    error Lapsed(uint256 lapsedAt, uint256 timestamp);
    error Expired(uint256 deadline, uint256 timestamp);
    error SignatureCountMismatch(uint256 provided, uint256 required);
    error SignersNotAscending(address previous, address current);
    error NotAGuardian(address signer);

    constructor() EIP712("GuardianModule", "1") {}

    function guardians(address account) external view returns (address[] memory) {
        return _guardians[account];
    }

    // --- configuration: only the account itself ------------------------------

    /// @notice Replaces the caller's guardians. Called by the account, through
    ///         an operation its owner signed.
    /// @dev Cancels any recovery in progress and spends the nonce: approvals
    ///      collected from the old guardians must not survive their removal.
    function setGuardians(address[] calldata newGuardians, uint256 newThreshold) external {
        address account = msg.sender;
        if (
            newThreshold == 0 || newThreshold > newGuardians.length
                || newGuardians.length > MAX_GUARDIANS
        ) {
            revert InvalidThreshold(newThreshold, newGuardians.length);
        }

        address[] storage current = _guardians[account];
        for (uint256 i; i < current.length; ++i) {
            isGuardian[account][current[i]] = false;
        }
        delete _guardians[account];

        for (uint256 i; i < newGuardians.length; ++i) {
            address guardian = newGuardians[i];
            // The account cannot vouch for itself, and an owner who is also a
            // guardian would count towards replacing their own lost key.
            if (
                guardian == address(0) || guardian == account
                    || guardian == SmartAccount(payable(account)).owner()
            ) {
                revert InvalidGuardian(guardian);
            }
            if (isGuardian[account][guardian]) revert DuplicateGuardian(guardian);
            isGuardian[account][guardian] = true;
            _guardians[account].push(guardian);
        }

        threshold[account] = newThreshold;
        _clearPending(account);
        emit GuardiansChanged(account, newGuardians, newThreshold);
    }

    // --- recovery -------------------------------------------------------------

    function hashRecovery(address account, address newOwner, uint256 nonce_, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(RECOVERY_TYPEHASH, account, newOwner, nonce_, deadline))
        );
    }

    function hashCancel(address account, uint256 nonce_, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, account, nonce_, deadline)));
    }

    /// @notice Starts handing `account` to `newOwner`, on a quorum of its
    ///         guardians' signatures. Anyone may submit them.
    function initiateRecovery(
        address account,
        address newOwner,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        if (SmartAccount(payable(account)).recoveryModule() != address(this)) {
            revert NotRecoveryModule(account);
        }
        if (newOwner == address(0)) revert InvalidNewOwner(newOwner);
        if (pending[account].executableAt != 0) revert RecoveryPending(account);

        _checkGuardianSignatures(
            account, hashRecovery(account, newOwner, nonce[account], deadline), deadline, signatures
        );
        ++nonce[account];

        // A uint64 of seconds outlasts the sun; the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executableAt = uint64(block.timestamp + RECOVERY_DELAY);
        pending[account] = Pending(newOwner, executableAt);
        emit RecoveryStarted(account, newOwner, executableAt);
    }

    /// @notice Completes a recovery once its delay has passed. Anyone may call
    ///         it: the guardians decided, and the owner had the delay to object.
    function executeRecovery(address account) external {
        Pending memory recovery = pending[account];
        if (recovery.executableAt == 0) revert NoRecoveryPending(account);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < recovery.executableAt) {
            revert NotReady(recovery.executableAt, block.timestamp);
        }
        uint256 lapsesAt = recovery.executableAt + EXECUTION_WINDOW;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > lapsesAt) revert Lapsed(lapsesAt, block.timestamp);

        delete pending[account];
        emit RecoveryExecuted(account, recovery.newOwner);
        SmartAccount(payable(account)).transferOwnership(recovery.newOwner);
    }

    /// @notice The owner's veto: called by the account itself, through an
    ///         operation the current key signed. If that key still works, the
    ///         recovery was never needed.
    function cancelRecovery() external {
        if (pending[msg.sender].executableAt == 0) revert NoRecoveryPending(msg.sender);
        _clearPending(msg.sender);
        emit RecoveryCancelled(msg.sender, msg.sender);
    }

    /// @notice The guardians withdrawing a recovery they started -- a mistaken
    ///         new key, say. Needs the same quorum that started it, signing over
    ///         the current nonce, so it cancels this recovery and no other.
    function cancelRecoveryWithGuardians(
        address account,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        if (pending[account].executableAt == 0) revert NoRecoveryPending(account);
        _checkGuardianSignatures(
            account, hashCancel(account, nonce[account], deadline), deadline, signatures
        );
        _clearPending(account);
        emit RecoveryCancelled(account, address(this));
    }

    // --- internals ------------------------------------------------------------

    function _clearPending(address account) private {
        delete pending[account];
        ++nonce[account];
    }

    /// @dev Exactly the vault's rules. Strictly ascending signers make them
    ///      distinct, and ECDSA.recover rejects malformed and malleable
    ///      signatures by reverting.
    function _checkGuardianSignatures(
        address account,
        bytes32 digest,
        uint256 deadline,
        bytes[] calldata signatures
    ) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired(deadline, block.timestamp);
        uint256 required = threshold[account];
        if (required == 0 || signatures.length != required) {
            revert SignatureCountMismatch(signatures.length, required);
        }

        address previous = address(0);
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= previous) revert SignersNotAscending(previous, signer);
            if (!isGuardian[account][signer]) revert NotAGuardian(signer);
            previous = signer;
        }
    }
}
