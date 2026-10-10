import { decodeAbiParameters, decodeFunctionData, erc20Abi, size, slice, type Address, type Hex } from "viem";

import { EXECUTE_USER_OP_SELECTOR, smartAccountAbi } from "../smart-account.ts";

/** The most calls one sponsored batch may carry. */
export const MAX_BATCH_CALLS = 10;

export type CallVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the platform pays for this call data.
 *
 * Only token transfers of the platform's own token, from the account's own
 * execute or executeBatch. A paymaster pays even when the call reverts, and
 * pays for whatever the call does: sponsoring arbitrary calls would let anyone
 * burn the deposit on work the platform has no interest in -- or on an
 * approve() that hands the user's tokens to someone else at the platform's
 * expense.
 */
export function checkCalls(callData: Hex, token: Address): CallVerdict {
    // A session key's single call, through executeUserOp. The same rules apply:
    // the paymaster pays the same whoever signed.
    if (size(callData) >= 4 && slice(callData, 0, 4).toLowerCase() === EXECUTE_USER_OP_SELECTOR) {
        let target, value, data;
        try {
            [target, value, data] = decodeAbiParameters(
                [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
                slice(callData, 4),
            );
        } catch {
            return { allowed: false, reason: "malformed executeUserOp call data" };
        }
        return checkEach([{ target, value, data }], token);
    }

    let decoded;
    try {
        decoded = decodeFunctionData({ abi: smartAccountAbi, data: callData });
    } catch {
        return { allowed: false, reason: "call data is not an execute or executeBatch" };
    }

    const calls =
        decoded.functionName === "execute"
            ? [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
            : decoded.functionName === "executeBatch"
              ? decoded.args[0]
              : undefined;
    if (calls === undefined) {
        return { allowed: false, reason: `${decoded.functionName} is not sponsored` };
    }
    if (calls.length === 0 || calls.length > MAX_BATCH_CALLS) {
        return { allowed: false, reason: `a batch must hold 1 to ${MAX_BATCH_CALLS} calls` };
    }
    return checkEach(calls, token);
}

function checkEach(
    calls: readonly { target: Address; value: bigint; data: Hex }[],
    token: Address,
): CallVerdict {
    for (const [index, call] of calls.entries()) {
        if (call.target.toLowerCase() !== token.toLowerCase()) {
            return { allowed: false, reason: `call ${index} targets ${call.target}, not the token` };
        }
        if (call.value !== 0n) {
            return { allowed: false, reason: `call ${index} sends ether` };
        }
        // Exactly transfer(address, uint256): a selector, then two words. Extra
        // bytes would mean the call is not what it looks like.
        if (size(call.data) !== 68) {
            return { allowed: false, reason: `call ${index} is not a plain token transfer` };
        }
        let inner;
        try {
            inner = decodeFunctionData({ abi: erc20Abi, data: call.data });
        } catch {
            return { allowed: false, reason: `call ${index} is not a token call` };
        }
        if (inner.functionName !== "transfer") {
            return { allowed: false, reason: `call ${index} is ${inner.functionName}, only transfer is sponsored` };
        }
    }

    return { allowed: true };
}

/**
 * The most an operation can cost whoever pays for it: every gas limit the
 * EntryPoint may consume, times the highest fee the operation accepts.
 * This is what the EntryPoint reserves from the paymaster's deposit.
 */
export function maxCost(op: {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    paymasterVerificationGasLimit: bigint;
    paymasterPostOpGasLimit: bigint;
    maxFeePerGas: bigint;
}): bigint {
    return (
        (op.callGasLimit +
            op.verificationGasLimit +
            op.preVerificationGas +
            op.paymasterVerificationGasLimit +
            op.paymasterPostOpGasLimit) *
        op.maxFeePerGas
    );
}
