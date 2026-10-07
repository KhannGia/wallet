import { hashTypedData, type Address } from "viem";

const domain = (module: Address, chainId: number) => ({
    name: "GuardianModule",
    version: "1",
    chainId,
    verifyingContract: module,
});

/** What a guardian signs to approve handing `account` to `newOwner`. */
export function recoveryTypedData(
    module: Address,
    chainId: number,
    message: { account: Address; newOwner: Address; nonce: bigint; deadline: bigint },
) {
    return {
        domain: domain(module, chainId),
        types: {
            Recovery: [
                { name: "account", type: "address" },
                { name: "newOwner", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        primaryType: "Recovery",
        message,
    } as const;
}

/** What a guardian signs to withdraw a recovery that has started. */
export function cancelTypedData(
    module: Address,
    chainId: number,
    message: { account: Address; nonce: bigint; deadline: bigint },
) {
    return {
        domain: domain(module, chainId),
        types: {
            CancelRecovery: [
                { name: "account", type: "address" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        primaryType: "CancelRecovery",
        message,
    } as const;
}

export const recoveryDigest = (...args: Parameters<typeof recoveryTypedData>) =>
    hashTypedData(recoveryTypedData(...args));
export const cancelDigest = (...args: Parameters<typeof cancelTypedData>) =>
    hashTypedData(cancelTypedData(...args));
