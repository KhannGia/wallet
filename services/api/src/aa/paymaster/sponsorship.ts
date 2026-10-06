import {
    concat,
    encodePacked,
    hashTypedData,
    keccak256,
    numberToHex,
    pad,
    type Address,
    type Hex,
} from "viem";
import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex");
const quantity = hex.transform((value) => BigInt(value));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte address");

/**
 * A UserOperation as ERC-7677 delivers it: EntryPoint v0.7+ fields, every
 * number a hex string. The gas fields can still be missing in a stub request,
 * before the bundler has estimated them.
 */
export const rpcUserOperationSchema = z.object({
    sender: address,
    nonce: quantity,
    factory: address.optional().nullable(),
    factoryData: hex.optional().nullable(),
    callData: hex,
    callGasLimit: quantity.optional(),
    verificationGasLimit: quantity.optional(),
    preVerificationGas: quantity.optional(),
    maxFeePerGas: quantity.optional(),
    maxPriorityFeePerGas: quantity.optional(),
    paymasterVerificationGasLimit: quantity.optional(),
    paymasterPostOpGasLimit: quantity.optional(),
});
export type RpcUserOperation = z.infer<typeof rpcUserOperationSchema>;

/** An operation with every field the sponsorship covers filled in. */
export interface PricedUserOperation {
    sender: Address;
    nonce: bigint;
    factory?: Address | null;
    factoryData?: Hex | null;
    callData: Hex;
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    paymasterVerificationGasLimit: bigint;
    paymasterPostOpGasLimit: bigint;
}

/** Two uint128s packed into one word, high then low, as v0.8 packs gas fields. */
function packUints(high: bigint, low: bigint): Hex {
    return pad(numberToHex((high << 128n) | low), { size: 32 });
}

/**
 * The EIP-712 sponsorship VerifyingPaymaster checks, field for field. A test
 * compares its digest to the contract's own hashSponsorship, so the two cannot
 * drift apart unnoticed.
 */
export function sponsorshipTypedData(params: {
    op: PricedUserOperation;
    paymaster: Address;
    chainId: number;
    validUntil: number;
    validAfter: number;
}) {
    const { op } = params;
    const initCode: Hex = op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x";

    return {
        domain: {
            name: "WalletPaymaster",
            version: "1",
            chainId: params.chainId,
            verifyingContract: params.paymaster,
        },
        types: {
            Sponsorship: [
                { name: "sender", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "initCodeHash", type: "bytes32" },
                { name: "callDataHash", type: "bytes32" },
                { name: "accountGasLimits", type: "bytes32" },
                { name: "preVerificationGas", type: "uint256" },
                { name: "gasFees", type: "bytes32" },
                { name: "paymasterGasLimits", type: "bytes32" },
                { name: "validUntil", type: "uint48" },
                { name: "validAfter", type: "uint48" },
            ],
        },
        primaryType: "Sponsorship",
        message: {
            sender: op.sender,
            nonce: op.nonce,
            initCodeHash: keccak256(initCode),
            callDataHash: keccak256(op.callData),
            accountGasLimits: packUints(op.verificationGasLimit, op.callGasLimit),
            preVerificationGas: op.preVerificationGas,
            gasFees: packUints(op.maxPriorityFeePerGas, op.maxFeePerGas),
            paymasterGasLimits: packUints(op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit),
            validUntil: params.validUntil,
            validAfter: params.validAfter,
        },
    } as const;
}

export function sponsorshipDigest(params: Parameters<typeof sponsorshipTypedData>[0]): Hex {
    return hashTypedData(sponsorshipTypedData(params));
}

/** The paymaster's own data: the validity window, then the signature. */
export function encodePaymasterData(validUntil: number, validAfter: number, signature: Hex): Hex {
    return encodePacked(["uint48", "uint48", "bytes"], [validUntil, validAfter, signature]);
}
