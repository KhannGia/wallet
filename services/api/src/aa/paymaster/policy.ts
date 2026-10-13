import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeFunctionData,
    erc20Abi,
    parseAbi,
    size,
    slice,
    type Address,
    type Hex,
} from "viem";

import { EXECUTE_USER_OP_SELECTOR, smartAccountAbi } from "../smart-account.ts";

/** The most calls one sponsored batch may carry. */
export const MAX_BATCH_CALLS = 10;

/** GuardianModule's own limit. A longer list would revert, at the platform's expense. */
export const MAX_GUARDIANS = 10;

// Separate, so decoding the module's call data can only ever find setGuardians:
// any other selector fails to decode rather than being mistaken for it.
const adoptModuleAbi = parseAbi(["function setRecoveryModule(address module)"]);
const setGuardiansAbi = parseAbi(["function setGuardians(address[] guardians, uint256 threshold)"]);

/** What a verdict depends on besides the call data. */
export interface PolicyContext {
    /** The platform's token: transfers of it are sponsored. */
    token: Address;
    /** The operation's sender, the only account whose recovery it may set up. */
    account: Address;
    /** The guardian module accounts may adopt for free. Without one, recovery setup is not sponsored. */
    guardianModule?: Address;
}

export type CallVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the platform pays for this call data.
 *
 * Token transfers of the platform's own token, from the account's own execute
 * or executeBatch -- and, from the owner only, setting up recovery: adopting the
 * platform's guardian module and naming guardians in it. That is what an
 * account does when it is activated, before it holds anything to transfer, and
 * the platform wants every graduated account to be able to do it for free.
 *
 * Nothing else. A paymaster pays even when the call reverts, and pays for
 * whatever the call does: sponsoring arbitrary calls would let anyone burn the
 * deposit on work the platform has no interest in -- or on an approve() that
 * hands the user's tokens to someone else at the platform's expense.
 */
export function checkCalls(callData: Hex, context: PolicyContext): CallVerdict {
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
        // Token transfers only: a session key never reaches the account's
        // configuration, and the contract would refuse it anyway.
        return checkEach([{ target, value, data }], { token: context.token, account: context.account });
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
    return checkEach(calls, context);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function checkEach(
    calls: readonly { target: Address; value: bigint; data: Hex }[],
    context: PolicyContext,
): CallVerdict {
    for (const [index, call] of calls.entries()) {
        if (call.value !== 0n) {
            return { allowed: false, reason: `call ${index} sends ether` };
        }
        if (!same(call.target, context.token)) {
            if (context.guardianModule === undefined) {
                return { allowed: false, reason: `call ${index} targets ${call.target}, not the token` };
            }
            const verdict = checkRecoverySetup(index, call, context.account, context.guardianModule);
            if (!verdict.allowed) return verdict;
            continue;
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
 * Whether a call that is not a token transfer is recovery setup the platform
 * pays for. Both kinds are compared byte for byte against their canonical
 * encoding, so call data carrying anything beyond the arguments is refused.
 */
function checkRecoverySetup(
    index: number,
    call: { target: Address; data: Hex },
    account: Address,
    guardianModule: Address,
): CallVerdict {
    // The account adopting the platform's module -- that module, no other, and
    // on itself, not on some other account.
    if (same(call.target, account)) {
        const adopt = encodeFunctionData({
            abi: adoptModuleAbi,
            functionName: "setRecoveryModule",
            args: [guardianModule],
        });
        if (same(call.data, adopt)) return { allowed: true };
        return { allowed: false, reason: `call ${index} is not adopting the guardian module` };
    }

    // The account naming its guardians in that module. The module keys them by
    // its caller, so they can only ever be the sender's own.
    if (same(call.target, guardianModule)) {
        let decoded;
        try {
            decoded = decodeFunctionData({ abi: setGuardiansAbi, data: call.data });
        } catch {
            return { allowed: false, reason: `call ${index} is not setGuardians` };
        }
        const [guardians, threshold] = decoded.args;
        if (guardians.length > MAX_GUARDIANS) {
            return { allowed: false, reason: `call ${index} names more than ${MAX_GUARDIANS} guardians` };
        }
        const canonical = encodeFunctionData({
            abi: setGuardiansAbi,
            functionName: "setGuardians",
            args: [guardians, threshold],
        });
        if (!same(call.data, canonical)) {
            return { allowed: false, reason: `call ${index} is not a plain setGuardians` };
        }
        return { allowed: true };
    }

    return { allowed: false, reason: `call ${index} targets ${call.target}, not the token` };
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
