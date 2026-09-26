// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title M-of-N vault for the platform's reserves.
/// @notice Holds the funds the platform keeps on behalf of users, and moves them
///         only when `threshold` distinct owners have signed the exact call.
///         No single owner -- the operator included -- can drain it alone.
/// @dev What is written here is the multisig logic itself. The primitives that
///      are dangerous to hand-roll are OpenZeppelin's: ECDSA recovery (which
///      rejects malleable signatures), the EIP-712 domain, and the reentrancy
///      guard.
contract MultisigVault is EIP712, ReentrancyGuard {
    /// @dev Every field that decides what the call does is signed. Leaving any
    ///      of them out would let whoever submits the transaction change it
    ///      after the owners approved it.
    bytes32 public constant EXECUTE_TYPEHASH =
        keccak256("Execute(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline)");

    uint256 public immutable threshold;

    /// @notice Incremented by every successful execution. Signatures cover the
    ///         nonce, so each approval can be spent exactly once.
    uint256 public nonce;

    mapping(address => bool) public isOwner;
    address[] private _owners;

    event Executed(
        uint256 indexed nonce, address indexed to, uint256 value, bytes data, bytes result
    );
    event Deposited(address indexed from, uint256 value);

    error InvalidThreshold(uint256 threshold, uint256 ownerCount);
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error Expired(uint256 deadline, uint256 timestamp);
    error SignatureCountMismatch(uint256 provided, uint256 required);
    error SignersNotAscending(address previous, address current);
    error NotAnOwner(address signer);
    error CallFailed(bytes returndata);

    constructor(address[] memory owners_, uint256 threshold_) EIP712("MultisigVault", "1") {
        if (threshold_ == 0 || threshold_ > owners_.length) {
            revert InvalidThreshold(threshold_, owners_.length);
        }

        for (uint256 i; i < owners_.length; ++i) {
            address owner = owners_[i];
            if (owner == address(0) || owner == address(this)) revert InvalidOwner(owner);
            if (isOwner[owner]) revert DuplicateOwner(owner);
            isOwner[owner] = true;
        }

        _owners = owners_;
        threshold = threshold_;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    /// @notice The digest owners sign for a given call. Exposed so off-chain
    ///         signers compute exactly what the contract will verify.
    /// @dev The EIP-712 domain binds the chain id and this contract's address,
    ///      so a signature collected for one vault or one chain is worthless on
    ///      any other.
    function hashExecute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 nonce_,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(EXECUTE_TYPEHASH, to, value, keccak256(data), nonce_, deadline))
        );
    }

    /// @notice Performs `to.call{value}(data)` once `threshold` owners have signed it.
    /// @param signatures Exactly `threshold` signatures, ordered by signer
    ///        address, strictly ascending.
    /// @dev Strictly ascending order is what makes the signers distinct: without
    ///      it, one owner's signature repeated `threshold` times would pass.
    ///
    ///      A reverted call reverts everything, the nonce increment included, so
    ///      the same approval can be retried -- once the vault is funded, say --
    ///      until its deadline passes.
    ///
    ///      This is a generic call and the vault cannot know what success means
    ///      to the target. An ERC-20 that signals failure by returning false
    ///      rather than reverting will look like a success here; whoever proposes
    ///      a transfer must check the return data, exactly as the payout worker
    ///      checks for a Transfer event.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes[] calldata signatures
    ) external nonReentrant returns (bytes memory result) {
        // A proposer can shift this by a few seconds at most, and a multisig
        // deadline is measured in hours. The skew cannot turn an expired
        // approval into a live one in any way that matters.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) {
            revert Expired(deadline, block.timestamp);
        }
        if (signatures.length != threshold) {
            revert SignatureCountMismatch(signatures.length, threshold);
        }

        uint256 currentNonce = nonce;
        bytes32 digest = hashExecute(to, value, data, currentNonce, deadline);

        address previous = address(0);
        for (uint256 i; i < signatures.length; ++i) {
            // ECDSA.recover reverts on a malformed or malleable signature rather
            // than returning the zero address or a second valid signer.
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= previous) revert SignersNotAscending(previous, signer);
            if (!isOwner[signer]) revert NotAnOwner(signer);
            previous = signer;
        }

        // Effects before interactions: the approval is spent before control
        // leaves the contract, so a reentrant call cannot reuse it even if the
        // guard were ever removed.
        nonce = currentNonce + 1;

        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);

        emit Executed(currentNonce, to, value, data, result);
    }
}
