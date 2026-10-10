import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Session keys at rest: AES-256-GCM under a master key that lives only in the
 * session manager's environment.
 *
 * GCM authenticates as well as encrypts, so a ciphertext that was altered --
 * or produced under another key -- fails to decrypt rather than yielding a
 * different, wrong private key. Each key gets its own random 96-bit IV; reusing
 * an IV under one master key would break GCM entirely.
 *
 * The additional authenticated data binds a ciphertext to the session it
 * belongs to. Without it, someone able to write to the database could swap two
 * rows' ciphertexts, and the service would sign for one session with another's
 * key -- a key granted different permissions.
 */

export interface SealedKey {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
}

const ALGORITHM = "aes-256-gcm";

export function parseMasterKey(hex: string): Buffer {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("the session master key must be 32 bytes of hex");
    }
    return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/** What a ciphertext is bound to: the account and the session key's address. */
export function sessionAad(account: string, sessionAddress: string): Buffer {
    return Buffer.from(`${account.toLowerCase()}:${sessionAddress.toLowerCase()}`, "utf8");
}

export function sealKey(masterKey: Buffer, privateKey: `0x${string}`, aad: Buffer): SealedKey {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, masterKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Throws if the ciphertext, IV, tag, master key or binding is not the one sealed. */
export function openKey(masterKey: Buffer, sealed: SealedKey, aad: Buffer): `0x${string}` {
    const decipher = createDecipheriv(ALGORITHM, masterKey, sealed.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return `0x${plaintext.toString("hex")}`;
}
