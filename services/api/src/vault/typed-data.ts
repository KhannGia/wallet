import { hashTypedData, type Address, type Hex } from "viem";

export interface VaultCall {
    to: Address;
    value: bigint;
    data: Hex;
    nonce: bigint;
    deadline: bigint;
}

/**
 * The EIP-712 definition of a vault approval, exactly as MultisigVault declares
 * it. This is what an owner's wallet displays and signs.
 *
 * Name, version, field names, field types and field order all feed the hash. A
 * one-character difference from the contract produces a different digest, and
 * every signature collected against it is rejected on submission.
 */
export function executeTypedData(vault: Address, chainId: number, call: VaultCall) {
    return {
        domain: {
            name: "MultisigVault",
            version: "1",
            chainId,
            verifyingContract: vault,
        },
        types: {
            Execute: [
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "data", type: "bytes" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        primaryType: "Execute",
        message: call,
    } as const;
}

export function executeDigest(vault: Address, chainId: number, call: VaultCall): Hex {
    return hashTypedData(executeTypedData(vault, chainId, call));
}
