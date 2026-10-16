import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * The owner key of a user's smart account. Made here, kept here, and never
 * sent anywhere: the platform learns its address and nothing else.
 *
 * Kept in this browser's localStorage, so it survives a reload but not a new
 * browser, a cleared profile, or a lost laptop -- which is what the backup and
 * the guardians are for. A real wallet would keep it in a passkey or a
 * hardware key; for a learning project, localStorage and a stern warning.
 */

const storageKey = (accountId: string) => `wallet.owner.${accountId}`;
const savedKey = (accountId: string) => `wallet.owner.${accountId}.saved`;

export function loadOwner(accountId: string): PrivateKeyAccount | null {
    const key = localStorage.getItem(storageKey(accountId));
    return key ? privateKeyToAccount(key as Hex) : null;
}

export function createOwner(accountId: string): PrivateKeyAccount {
    const key = generatePrivateKey();
    localStorage.setItem(storageKey(accountId), key);
    return privateKeyToAccount(key);
}

/** Brings a backed-up key to this browser. Refuses anything that is not a private key. */
export function importOwner(accountId: string, key: string): PrivateKeyAccount {
    const trimmed = key.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("A private key is 0x followed by 64 hex characters");
    const account = privateKeyToAccount(trimmed as Hex);
    localStorage.setItem(storageKey(accountId), trimmed);
    localStorage.setItem(savedKey(accountId), "1");
    return account;
}

/** Hands the key to the user as a file, once they ask for it. */
export function downloadBackup(accountId: string): void {
    const key = localStorage.getItem(storageKey(accountId));
    if (!key) return;
    const owner = privateKeyToAccount(key as Hex);
    const blob = new Blob(
        [JSON.stringify({ warning: "Anyone with this key controls your smart account.", owner: owner.address, privateKey: key }, null, 2)],
        { type: "application/json" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `owner-key-${owner.address.slice(0, 8)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
}

export const isBackedUp = (accountId: string) => localStorage.getItem(savedKey(accountId)) === "1";
export const markBackedUp = (accountId: string) => localStorage.setItem(savedKey(accountId), "1");
