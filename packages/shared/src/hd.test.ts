import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "viem/accounts";

import {
    ACCOUNT_PATH,
    deriveDepositAddress,
    generateWallet,
    loadWatchOnlyKey,
    xpubFromMnemonic,
} from "./hd.ts";

// The public Foundry/anvil test mnemonic. It controls nothing of value, and
// the addresses it produces are published in anvil's own startup banner, which
// makes them an independent test vector rather than a value this code
// generated for itself.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

const ANVIL_ADDRESSES = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

describe("HD deposit address derivation", () => {
    const xpub = xpubFromMnemonic(ANVIL_MNEMONIC);

    it("matches the published anvil addresses", () => {
        // This is the assertion that catches every silent failure mode: a
        // compressed key passed to publicKeyToAddress, or derivation from the
        // wrong depth, both produce valid-looking addresses that fail here.
        ANVIL_ADDRESSES.forEach((expected, index) => {
            assert.equal(deriveDepositAddress(xpub, index), expected, `index ${index}`);
        });
    });

    it("derives without any private key present", () => {
        const node = loadWatchOnlyKey(xpub);
        assert.equal(node.privateKey, null);

        // Asking a watch-only node for its private side throws rather than
        // quietly returning nothing, so there is no path by which the API
        // server could obtain spending authority.
        assert.throws(() => node.privateExtendedKey, /No private key/);
    });

    it("refuses an extended private key", () => {
        // An xprv at the same path: configuring the server with this instead of
        // the xpub would hand it spending authority over every deposit address.
        const xprv = masterOf(ANVIL_MNEMONIC).derive(ACCOUNT_PATH).privateExtendedKey;
        assert.throws(() => loadWatchOnlyKey(xprv), /must be configured with an xpub/);
    });

    it("refuses a key derived at the wrong depth", () => {
        // The master xpub is depth 0, not 4. Deriving index i from it walks a
        // completely different branch and yields addresses nobody holds keys to.
        const masterXpub = masterOf(ANVIL_MNEMONIC).publicExtendedKey;
        assert.throws(() => loadWatchOnlyKey(masterXpub), /depth 0, expected 4/);
    });

    it("rejects a hardened or negative index", () => {
        assert.throws(() => deriveDepositAddress(xpub, -1), /non-hardened/);
        assert.throws(() => deriveDepositAddress(xpub, 2 ** 31), /non-hardened/);
        assert.throws(() => deriveDepositAddress(xpub, 1.5), /non-hardened/);
    });

    it("is deterministic", () => {
        assert.equal(deriveDepositAddress(xpub, 42), deriveDepositAddress(xpub, 42));
        assert.notEqual(deriveDepositAddress(xpub, 42), deriveDepositAddress(xpub, 43));
    });

    it("round-trips a freshly generated wallet", () => {
        const wallet = generateWallet();

        assert.equal(wallet.mnemonic.split(" ").length, 24);
        assert.equal(wallet.xpub, xpubFromMnemonic(wallet.mnemonic));
        assert.match(deriveDepositAddress(wallet.xpub, 0), /^0x[0-9a-fA-F]{40}$/);

        // A different wallet must not produce the same addresses.
        assert.notEqual(deriveDepositAddress(generateWallet().xpub, 0),
                        deriveDepositAddress(wallet.xpub, 0));
    });

    it("exports at the documented BIP-44 path", () => {
        assert.equal(ACCOUNT_PATH, "m/44'/60'/0'/0");
    });
});

// Builds the private-side keys the tests above must reject. Only a test has
// any business constructing these.
function masterOf(mnemonic: string): HDKey {
    return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
}
