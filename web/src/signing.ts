import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Typed data as the API hands it out: integers as decimal strings, the shape
 * eth_signTypedData_v4 takes. A real wallet reads it as is; here the page signs
 * it, with a key the user pastes -- a guardian's or a vault owner's -- since
 * the demo has no wallet extension. Integer fields are read back as numbers.
 */
export interface TypedDataJson {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
}

const INTEGER = /^u?int\d*$/;

export function signTypedJson(signer: PrivateKeyAccount, typed: TypedDataJson): Promise<Hex> {
    const { EIP712Domain: _domain, ...types } = typed.types;
    const fields = types[typed.primaryType] ?? [];
    const message = Object.fromEntries(
        Object.entries(typed.message).map(([name, value]) => {
            const field = fields.find((f) => f.name === name);
            return [name, field && INTEGER.test(field.type) && typeof value === "string" ? BigInt(value) : value];
        }),
    );
    return signer.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message } as never);
}

/** A pasted private key, refused unless it is one. */
export function keyFrom(input: string): PrivateKeyAccount {
    const trimmed = input.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("A private key is 0x followed by 64 hex characters");
    return privateKeyToAccount(trimmed as Hex);
}
