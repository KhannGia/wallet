import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Pool } from "../db/pool.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { registerHotWallet } from "./nonce.ts";
import {
    assertDistinctSigners,
    funderRunningLow,
    HOT_WALLET_ID,
    registeredHotWallet,
} from "./signer-roles.ts";

describe("signer roles", () => {
    let pool: Pool;

    before(() => {
        pool = testPool();
    });
    beforeEach(async () => {
        await resetDatabase(pool);
    });
    after(async () => {
        await pool.end();
    });

    it("accepts separate keys and ignores roles that are not configured", () => {
        assert.doesNotThrow(() =>
            assertDistinctSigners({
                hot: generatePrivateKey(),
                gasFunder: generatePrivateKey(),
                vaultSubmitter: undefined,
            }),
        );
    });

    it("refuses the gas funder sharing the hot wallet's key", () => {
        const hot = generatePrivateKey();

        // The bug this guards against: the sweeper funding gas from the hot
        // wallet with node-assigned nonces, while the withdrawal worker hands
        // out the same nonces from the database.
        assert.throws(
            () => assertDistinctSigners({ hot, gasFunder: hot }),
            /hot and gasFunder use the same key/,
        );
    });

    it("compares accounts, not the spelling of the key", () => {
        const key = generatePrivateKey();
        assert.throws(() => assertDistinctSigners({ hot: key, vaultSubmitter: key.toUpperCase().replace("0X", "0x") }));
    });

    it("reads the hot wallet the withdrawal worker registered", async () => {
        const address = privateKeyToAccount(generatePrivateKey()).address;
        await registerHotWallet(pool, HOT_WALLET_ID, address, 0n);

        assert.equal(await registeredHotWallet(pool), address);
    });

    it("refuses to guess a destination when none is registered", async () => {
        await assert.rejects(registeredHotWallet(pool), /No hot wallet is registered/);
    });

    it("warns while ten fundings are still affordable, not after", () => {
        assert.equal(funderRunningLow(100n, 10n), false);
        assert.equal(funderRunningLow(99n, 10n), true);
    });
});
