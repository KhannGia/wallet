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
const cancelRecoveryAbi = parseAbi(["function cancelRecovery()"]);
const sessionAbi = parseAbi([
    "struct Condition { uint8 param; uint8 operator; bytes32 value; }",
    "struct Permission { address target; bytes4 selector; Condition[] conditions; }",
    "struct SpendLimit { address token; uint256 limit; }",
    "function addSession(address key, uint48 validAfter, uint48 validUntil, uint256 nativeLimit, Permission[] permissions, SpendLimit[] limits)",
    "function revokeSession(address key)",
]);

/** The most permissions, spend limits, or conditions on one permission, a sponsored session may carry. */
export const MAX_SESSION_RULES = 10;

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
 * or executeBatch -- and, from the owner only, looking after the account:
 * adopting the platform's guardian module and naming guardians in it, vetoing a
 * recovery the owner did not ask for, granting and revoking session keys. A
 * graduated account holds no ether, and none of that should need any.
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
        return checkEach([{ target, value, data }], { token: context.token, account: context.account }, false);
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
    return checkEach(calls, context, true);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function checkEach(
    calls: readonly { target: Address; value: bigint; data: Hex }[],
    context: PolicyContext,
    fromOwner: boolean,
): CallVerdict {
    for (const [index, call] of calls.entries()) {
        if (call.value !== 0n) {
            return { allowed: false, reason: `call ${index} sends ether` };
        }
        if (!same(call.target, context.token)) {
            if (!fromOwner) {
                return { allowed: false, reason: `call ${index} targets ${call.target}, not the token` };
            }
            const verdict = checkAdministration(index, call, context.account, context.guardianModule);
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

/** Call data equal byte for byte to its canonical encoding: nothing hidden after the arguments. */
function canonical(data: Hex, encoded: Hex): boolean {
    return same(data, encoded);
}

/**
 * Whether an owner's call that is not a token transfer is administration the
 * platform pays for. Every kind is compared byte for byte against its
 * canonical encoding, so call data carrying anything beyond the arguments is
 * refused.
 */
function checkAdministration(
    index: number,
    call: { target: Address; data: Hex },
    account: Address,
    guardianModule: Address | undefined,
): CallVerdict {
    if (same(call.target, account)) {
        // Adopting the platform's module -- that module, no other, and on
        // itself, not on some other account.
        if (
            guardianModule !== undefined &&
            canonical(call.data, encodeFunctionData({ abi: adoptModuleAbi, functionName: "setRecoveryModule", args: [guardianModule] }))
        ) {
            return { allowed: true };
        }

        let decoded;
        try {
            decoded = decodeFunctionData({ abi: sessionAbi, data: call.data });
        } catch {
            return { allowed: false, reason: `call ${index} is not account administration the platform pays for` };
        }
        if (decoded.functionName === "revokeSession") {
            const encoded = encodeFunctionData({ abi: sessionAbi, functionName: "revokeSession", args: decoded.args });
            return canonical(call.data, encoded)
                ? { allowed: true }
                : { allowed: false, reason: `call ${index} is not a plain revokeSession` };
        }
        const [, , , , permissions, limits] = decoded.args;
        // Bounded, so one sponsored grant cannot be made arbitrarily expensive.
        if (
            permissions.length > MAX_SESSION_RULES ||
            limits.length > MAX_SESSION_RULES ||
            permissions.some((permission) => permission.conditions.length > MAX_SESSION_RULES)
        ) {
            return { allowed: false, reason: `call ${index} grants a session more than ${MAX_SESSION_RULES} rules of a kind` };
        }
        const encoded = encodeFunctionData({ abi: sessionAbi, functionName: "addSession", args: decoded.args });
        return canonical(call.data, encoded)
            ? { allowed: true }
            : { allowed: false, reason: `call ${index} is not a plain addSession` };
    }

    if (guardianModule !== undefined && same(call.target, guardianModule)) {
        // The owner vetoing a recovery in progress: free, or a lost-key alarm
        // would cost the very user it protects.
        if (canonical(call.data, encodeFunctionData({ abi: cancelRecoveryAbi, functionName: "cancelRecovery" }))) {
            return { allowed: true };
        }

        // Naming guardians in that module. The module keys them by its caller,
        // so they can only ever be the sender's own.
        let decoded;
        try {
            decoded = decodeFunctionData({ abi: setGuardiansAbi, data: call.data });
        } catch {
            return { allowed: false, reason: `call ${index} is not setGuardians or cancelRecovery` };
        }
        const [guardians, threshold] = decoded.args;
        if (guardians.length > MAX_GUARDIANS) {
            return { allowed: false, reason: `call ${index} names more than ${MAX_GUARDIANS} guardians` };
        }
        const encoded = encodeFunctionData({ abi: setGuardiansAbi, functionName: "setGuardians", args: [guardians, threshold] });
        return canonical(call.data, encoded)
            ? { allowed: true }
            : { allowed: false, reason: `call ${index} is not a plain setGuardians` };
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
