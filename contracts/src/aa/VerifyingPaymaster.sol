// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title Pays gas for UserOperations the platform has agreed to sponsor.
/// @notice A user with no ether cannot pay for their own operations. This
///         contract pays instead, out of its deposit in the EntryPoint -- but
///         only for an operation carrying the platform's signature over that
///         exact operation, issued by a backend that applies the sponsorship
///         policy. Without that check anyone could spend the deposit.
/// @dev paymasterAndData, as EntryPoint v0.8 lays it out, then this contract's
///      own data:
///
///        [0:20]    this paymaster's address
///        [20:36]   gas limit for validatePaymasterUserOp
///        [36:52]   gas limit for postOp
///        [52:58]   validUntil (uint48, unix seconds)
///        [58:64]   validAfter (uint48, unix seconds)
///        [64:129]  the sponsor's 65-byte signature
///
///      Validation reads only immutables. ERC-7562 restricts what a paymaster
///      may read during validation, and bundlers throttle or drop one that
///      breaks the rules -- so the signer is fixed at deployment, and rotating
///      it means deploying a new paymaster.
contract VerifyingPaymaster is IPaymaster, EIP712, Ownable2Step {
    /// @dev Every field that decides what the operation does or what it may
    ///      cost. The gas limits and fees are in it because the paymaster pays
    ///      up to their product: leaving any out would let the account raise
    ///      it after the sponsor signed.
    bytes32 public constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,"
        "bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,"
        "bytes32 paymasterGasLimits,uint48 validUntil,uint48 validAfter)"
    );

    uint256 private constant GAS_LIMITS_OFFSET = 20;
    uint256 private constant VALIDITY_OFFSET = 52;
    uint256 private constant SIGNATURE_OFFSET = 64;
    uint256 private constant PAYMASTER_DATA_LENGTH = SIGNATURE_OFFSET + 65;

    uint256 private constant SIG_VALIDATION_FAILED = 1;

    IEntryPoint public immutable entryPoint;

    /// @notice The key the sponsorship service signs with.
    address public immutable signer;

    error OnlyEntryPoint();
    error InvalidSigner();
    error InvalidPaymasterData(uint256 length);

    constructor(IEntryPoint entryPoint_, address signer_, address owner_)
        EIP712("WalletPaymaster", "1")
        Ownable(owner_)
    {
        if (signer_ == address(0)) revert InvalidSigner();
        entryPoint = entryPoint_;
        signer = signer_;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    /// @notice The digest the sponsor signs for an operation. Exposed so the
    ///         service computes exactly what this contract verifies.
    /// @dev The EIP-712 domain binds the chain and this paymaster's address, so
    ///      a sponsorship is worthless on another chain or another paymaster.
    function hashSponsorship(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SPONSORSHIP_TYPEHASH,
                    userOp.sender,
                    userOp.nonce,
                    keccak256(userOp.initCode),
                    keccak256(userOp.callData),
                    userOp.accountGasLimits,
                    userOp.preVerificationGas,
                    userOp.gasFees,
                    bytes32(userOp.paymasterAndData[GAS_LIMITS_OFFSET:VALIDITY_OFFSET]),
                    validUntil,
                    validAfter
                )
            )
        );
    }

    /// @inheritdoc IPaymaster
    /// @dev A bad signature is reported, not reverted, exactly as an account
    ///      reports one: a bundler simulating with placeholder data must get an
    ///      answer. The time range goes back to the EntryPoint, which enforces
    ///      it -- validation itself may not read the clock.
    ///
    ///      A sponsorship must expire. ERC-4337 reads a validUntil of zero as
    ///      "forever"; here it is treated as a failed signature, so a mistake in
    ///      the service cannot mint a sponsorship that never runs out.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        if (userOp.paymasterAndData.length != PAYMASTER_DATA_LENGTH) {
            revert InvalidPaymasterData(userOp.paymasterAndData.length);
        }

        uint48 validUntil =
            uint48(bytes6(userOp.paymasterAndData[VALIDITY_OFFSET:VALIDITY_OFFSET + 6]));
        uint48 validAfter =
            uint48(bytes6(userOp.paymasterAndData[VALIDITY_OFFSET + 6:SIGNATURE_OFFSET]));

        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(
            hashSponsorship(userOp, validUntil, validAfter),
            userOp.paymasterAndData[SIGNATURE_OFFSET:]
        );
        bool failed =
            recoverError != ECDSA.RecoverError.NoError || recovered != signer || validUntil == 0;

        // No context: nothing to settle after execution, so the EntryPoint
        // never calls postOp.
        context = "";
        validationData = (failed ? SIG_VALIDATION_FAILED : 0) | (uint256(validUntil) << 160)
            | (uint256(validAfter) << 208);
    }

    /// @inheritdoc IPaymaster
    /// @dev Never called: validation returns no context. Present because the
    ///      interface requires it.
    function postOp(PostOpMode, bytes calldata, uint256, uint256) external view onlyEntryPoint {}

    // --- the deposit gas is paid from, and the stake bundlers look for ---------

    /// @notice Tops up the deposit gas is paid from. Anyone may fund it.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    /// @notice A stake is locked collateral bundlers use to judge whether a
    ///         paymaster is worth serving; it is not spent on gas.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }
}
