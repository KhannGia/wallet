import { secp256k1 } from "@noble/curves/secp256k1";
import { generateMnemonic as generateBip39Mnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey, publicKeyToAddress } from "viem/accounts";
import type { Address } from "viem";

/**
 * BIP-44 for Ethereum: m / purpose' / coin_type' / account' / change.
 *
 * The extended public key is exported at this level, one step above the
 * addresses themselves, so the API server can derive m/44'/60'/0'/0/index for
 * any user while holding nothing that can spend.
 */
export const ACCOUNT_PATH = "m/44'/60'/0'/0";

/** Depth of a node at ACCOUNT_PATH: purpose, coin type, account, change. */
const ACCOUNT_PATH_DEPTH = 4;

/**
 * @noble/curves renamed ProjectivePoint to Point. Resolving it once at load
 * time turns an upgrade that drops one of the names into an immediate, loud
 * failure rather than a silent wrong address at runtime.
 */
const point = (() => {
    const curve = secp256k1 as unknown as Record<string, unknown>;
    const candidate = curve["Point"] ?? curve["ProjectivePoint"];
    if (candidate === undefined) {
        throw new Error("secp256k1 exposes neither Point nor ProjectivePoint");
    }
    return candidate as { fromHex(bytes: Uint8Array): { toHex(compressed: boolean): string } };
})();

/**
 * Converts a BIP-32 compressed public key into an Ethereum address.
 *
 * The decompression step is not optional. viem's publicKeyToAddress expects
 * the 65-byte uncompressed form and strips what it assumes is the 0x04 prefix;
 * handing it the 33-byte compressed key returns a plausible-looking but wrong
 * address with no error. Deposits sent there would be unrecoverable.
 */
function compressedPublicKeyToAddress(compressed: Uint8Array): Address {
    if (compressed.length !== 33) {
        throw new Error(`Expected a 33-byte compressed public key, got ${compressed.length}`);
    }
    const uncompressed = `0x${point.fromHex(compressed).toHex(false)}` as `0x${string}`;
    return publicKeyToAddress(uncompressed);
}

/**
 * Loads an extended public key for watch-only use.
 *
 * Rejects an extended *private* key outright. Misconfiguring WALLET_XPUB with
 * an xprv would silently hand the API server spending authority over every
 * deposit address, defeating the entire point of deriving from an xpub.
 */
export function loadWatchOnlyKey(extendedKey: string): HDKey {
    let node: HDKey;
    try {
        node = HDKey.fromExtendedKey(extendedKey);
    } catch (error) {
        throw new Error(`Invalid extended key: ${error instanceof Error ? error.message : error}`);
    }

    if (node.privateKey !== null) {
        throw new Error(
            "Extended key contains a private key. The API server must be configured " +
                "with an xpub, never an xprv.",
        );
    }

    if (node.depth !== ACCOUNT_PATH_DEPTH) {
        throw new Error(
            `Extended key is at depth ${node.depth}, expected ${ACCOUNT_PATH_DEPTH} ` +
                `(${ACCOUNT_PATH}). Deriving from the wrong level yields valid-looking ` +
                "addresses that nobody holds the keys to.",
        );
    }

    return node;
}

/** Derives the deposit address at m/44'/60'/0'/0/index from a watch-only key. */
export function deriveDepositAddress(extendedKey: string, index: number): Address {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
        throw new Error(`Derivation index must be a non-hardened integer, got ${index}`);
    }

    const child = loadWatchOnlyKey(extendedKey).deriveChild(index);
    if (child.publicKey === null) {
        throw new Error(`Derivation produced no public key at index ${index}`);
    }

    return compressedPublicKeyToAddress(child.publicKey);
}

export interface GeneratedWallet {
    mnemonic: string;
    xpub: string;
}

/**
 * Creates a fresh HD wallet. Runs offline, in the keygen tool only: the
 * mnemonic it returns must never reach a server, a log, or a file in this
 * repository.
 */
export function generateWallet(strengthBits = 256): GeneratedWallet {
    const mnemonic = generateBip39Mnemonic(wordlist, strengthBits);
    return { mnemonic, xpub: xpubFromMnemonic(mnemonic) };
}

/** Derives the ACCOUNT_PATH extended public key from a mnemonic. */
export function xpubFromMnemonic(mnemonic: string, passphrase?: string): string {
    // fromMasterSeed gives the depth-0 root. Note that viem's
    // mnemonicToAccount().getHdKey() returns a depth-5 node already at
    // .../0/0, so deriving ACCOUNT_PATH from that lands on a different branch.
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase));
    return master.derive(ACCOUNT_PATH).publicExtendedKey;
}
