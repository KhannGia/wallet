import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { createUser } from "../ledger/operations.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    mintTo,
    type ChainHarness,
} from "../test-support/chain.ts";
import { resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { planSweeps, sweepable, type SweepConfig } from "./sweep-planner.ts";

describe("sweep planner", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let token: Address;

    const config = (over: Partial<SweepConfig> = {}): SweepConfig => ({
        token,
        minTokenBalance: 1_000_000n,
        ...over,
    });

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        token = await deployMockUsdc(harness);
    });
    beforeEach(async () => {
        await resetDatabase(pool);

        // Each test gets its own stretch of derivation indices, for two
        // reasons. Indices 0-9 are anvil's own pre-funded accounts, since these
        // tests derive from the public anvil mnemonic, so an address that is
        // meant to be unable to pay for its own transfer must come from beyond
        // them. And the chain outlives the database: a test that funds an
        // address leaves it funded for every later run, so reusing a fixed
        // index makes the suite pass once and fail afterwards -- which is
        // exactly how this was found.
        const base = 1_000 + Math.floor(Math.random() * 1_000_000);
        await pool.query(`ALTER SEQUENCE deposit_address_index_seq RESTART WITH ${base}`);
    });
    after(async () => {
        await pool.end();
    });

    const newAccount = async (email: string) => {
        const created = await createUser(pool, { email, xpub: TEST_XPUB });
        return created.depositAddress as Address;
    };

    it("returns nothing when no accounts exist", async () => {
        assert.deepEqual(await planSweeps({ pool, client: harness.publicClient }, config()), []);
    });

    it("skips an address holding no tokens", async () => {
        await newAccount("empty@test.local");

        const plan = await planSweeps({ pool, client: harness.publicClient }, config());

        assert.equal(plan.length, 1);
        assert.equal(plan[0]?.decision, "empty");
        assert.deepEqual(sweepable(plan), []);
    });

    it("leaves a balance below the minimum alone", async () => {
        const address = await newAccount("dust@test.local");
        await mintTo(harness, token, address, 500n);

        const plan = await planSweeps({ pool, client: harness.publicClient }, config());

        // Sweeping dust costs more in gas than it recovers. The threshold is
        // what keeps the wallet from destroying value on its own deposits.
        assert.equal(plan[0]?.decision, "below_minimum");
        assert.deepEqual(sweepable(plan), []);
    });

    it("flags an address that cannot pay for its own transfer", async () => {
        const address = await newAccount("nogas@test.local");
        await mintTo(harness, token, address, 5_000_000n);

        const plan = await planSweeps({ pool, client: harness.publicClient }, config());
        const candidate = plan[0];

        assert.ok(candidate);
        // A deposit address receives tokens and nothing else, so it holds no
        // native currency and the sweep costs two transactions rather than one.
        assert.equal(candidate.decision, "needs_gas");
        assert.equal(candidate.nativeBalance, 0n);
        assert.equal(sweepable(plan).length, 1);
    });

    it("counts the funding transaction in the cost when gas is needed", async () => {
        const funded = await newAccount("funded@test.local");
        const unfunded = await newAccount("unfunded@test.local");
        await mintTo(harness, token, funded, 5_000_000n);
        await mintTo(harness, token, unfunded, 5_000_000n);

        // Give one of them enough native currency to pay its own way.
        const signer = anvilSigner(loadEnv(process.env).RPC_URL, 7);
        const account = signer.walletClient.account;
        assert.ok(account);
        const hash = await signer.walletClient.sendTransaction({
            account,
            chain: null,
            to: funded,
            value: 10n ** 17n,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        const plan = await planSweeps({ pool, client: harness.publicClient }, config());
        const ready = plan.find((c) => c.address === funded);
        const needsGas = plan.find((c) => c.address === unfunded);

        assert.equal(ready?.decision, "ready");
        assert.equal(needsGas?.decision, "needs_gas");
        assert.ok(
            needsGas !== undefined &&
                ready !== undefined &&
                needsGas.estimatedGasCostWei > ready.estimatedGasCostWei,
            "funding an address is an extra transaction, and the estimate must say so",
        );
    });

    it("reports candidates in derivation order", async () => {
        const first = await newAccount("a@test.local");
        const second = await newAccount("b@test.local");
        await mintTo(harness, token, second, 9_000_000n);
        await mintTo(harness, token, first, 9_000_000n);

        const plan = await planSweeps({ pool, client: harness.publicClient }, config());

        const indices = plan.map((c) => c.derivationIndex);
        assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
        assert.equal(indices.length, 2);
        assert.equal(indices[1], (indices[0] ?? 0) + 1);
    });
});
