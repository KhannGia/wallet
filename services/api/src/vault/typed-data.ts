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

/**
 * The same typed data, in the JSON shape `eth_signTypedData_v4` takes -- what
 * the API hands an owner to paste into, or send to, their wallet.
 *
 * Two differences from the viem form. Integers are decimal strings, because
 * JSON numbers are doubles and a wei amount does not survive one. And
 * EIP712Domain is spelled out, because wallets build the domain separator from
 * `types` and some refuse to sign without it.
 */
export function executeTypedDataJson(vault: Address, chainId: number, call: VaultCall) {
    const typed = executeTypedData(vault, chainId, call);
    return {
        domain: typed.domain,
        types: {
            EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
            ],
            ...typed.types,
        },
        primaryType: typed.primaryType,
        message: {
            to: call.to,
            value: call.value.toString(),
            data: call.data,
            nonce: call.nonce.toString(),
            deadline: call.deadline.toString(),
        },
    };
}
