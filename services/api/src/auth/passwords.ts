import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt, from node:crypto.
 *
 * scrypt is deliberately expensive in both time and memory, so an attacker
 * holding the users table cannot try billions of guesses a second the way
 * they could against a fast hash like SHA-256. The parameters are stored with
 * each hash, so raising them later leaves existing passwords verifiable.
 */

/** 2^15 rounds: about 32 MiB and tens of milliseconds per hash. */
const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
/** Above scrypt's own need of 128 * N * r bytes, which Node's default limit does not cover at this cost. */
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;
/** Hashing is costly by design, so an absurdly long input is refused before it is hashed. */
export const MAX_PASSWORD_LENGTH = 1024;

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
    const options: ScryptOptions = { ...cost, maxmem: MAX_MEMORY };
    return new Promise((resolve, reject) =>
        scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) =>
            error ? reject(error) : resolve(key),
        ),
    );
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, COST);
    return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltHex, keyHex] = parts as [string, string, string, string, string, string];
    const expected = Buffer.from(keyHex, "hex");
    const key = await derive(password, Buffer.from(saltHex, "hex"), { N: Number(N), r: Number(r), p: Number(p) });
    // Constant time: how many leading bytes matched must not show in how long
    // the comparison took.
    return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Hashed against when the email is unknown, so signing in as nobody takes as
 * long as signing in with a wrong password -- otherwise the delay would say
 * which emails have accounts.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
