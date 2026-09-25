import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Pool } from "../db/pool.ts";
import { createUser } from "../ledger/operations.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    mintTo,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { runSweepsOnce, type SweeperConfig, type SweeperDeps } from "./sweeper.ts";

/** The mnemonic TEST_XPUB was derived from. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

describe("sweeper", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let funder: Signer;
    let token: Address;
    let rpcUrl: string;
    let deps: SweeperDeps;

    const HOT_WALLET = "0x000000000000000000000000000000000000c0DE" as Address;

    const config = (over: Partial<SweeperConfig> = {}): SweeperConfig => ({
        token,
        minTokenBalance: 1_000_000n,
        hotWallet: HOT_WALLET,
        gasFundingWei: 2n * 10n ** 15n,
        mnemonic: ANVIL_MNEMONIC,
        ...over,
    });

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        rpcUrl = env.RPC_URL;
        pool = testPool();
        harness = chainHarness(rpcUrl);
        funder = anvilSigner(rpcUrl, 6);
        token = await deployMockUsdc(harness);
        deps = { pool, client: harness.publicClient, funder: funder.walletClient, rpcUrl };
    });

    beforeEach(async () => {
        await resetDatabase(pool);
        // Its own stretch of indices: anvil pre-funds 0-9, and the chain
        // outlives the database, so a fixed index would inherit balances from
        // earlier runs.
        const base = 2_000 + Math.floor(Math.random() * 1_000_000);
        await pool.query(`ALTER SEQUENCE deposit_address_index_seq RESTART WITH ${base}`);
    });

    after(async () => {
        await pool.end();
    });

    const depositAddressWith = async (email: string, amount: bigint): Promise<Address> => {
        const created = await createUser(pool, { email, xpub: TEST_XPUB });
        const address = created.depositAddress as Address;
        if (amount > 0n) {
            await mintTo(harness, token, address, amount);
        }
        return address;
    };

    const tokenBalance = (address: Address): Promise<bigint> =>
        harness.publicClient.readContract({
            address: token,
            abi: [
                {
                    type: "function",
                    name: "balanceOf",
                    inputs: [{ name: "", type: "address" }],
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                },
            ] as const,
            functionName: "balanceOf",
            args: [address],
        });

    it("funds an address that cannot pay, then empties it into the hot wallet", async () => {
        const address = await depositAddressWith("sweep@test.local", 7_000_000n);
        const hotBefore = await tokenBalance(HOT_WALLET);

        const result = await runSweepsOnce(deps, config());

        assert.deepEqual(result.failures, []);
        assert.equal(result.funded, 1, "a deposit address holds no native currency");
        assert.equal(result.swept, 1);
        assert.equal(result.sweptAmount, 7_000_000n);

        assert.equal(await tokenBalance(address), 0n);
        assert.equal(await tokenBalance(HOT_WALLET), hotBefore + 7_000_000n);
    });

    it("does nothing on a second pass", async () => {
        await depositAddressWith("again@test.local", 4_000_000n);

        await runSweepsOnce(deps, config());
        const second = await runSweepsOnce(deps, config());

        // The pass re-reads balances rather than tracking state, so an already
        // empty address simply drops out of the plan.
        assert.equal(second.planned, 0);
        assert.equal(second.swept, 0);
    });

    it("leaves a balance below the minimum where it is", async () => {
        const address = await depositAddressWith("dust@test.local", 900n);

        const result = await runSweepsOnce(deps, config());

        assert.equal(result.planned, 0);
        assert.equal(await tokenBalance(address), 900n);
    });

    it("refuses to sign with a mnemonic that does not match the xpub", async () => {
        await depositAddressWith("mismatch@test.local", 5_000_000n);

        const wrong =
            "legal winner thank year wave sausage worth useful legal winner thank yellow";

        const result = await runSweepsOnce(deps, config({ mnemonic: wrong }));

        // A wrong mnemonic derives a valid key for a different address. Signing
        // would succeed and the tokens would never move, so the mismatch has to
        // be caught before anything is sent.
        assert.equal(result.swept, 0);
        assert.equal(result.failures.length, 1);
        assert.match(result.failures[0] ?? "", /does not match the configured xpub/);
    });

    it("reports every failure instead of stopping at the first", async () => {
        await depositAddressWith("first@test.local", 3_000_000n);
        await depositAddressWith("second@test.local", 4_000_000n);

        // A funder with no native currency at all: every gas funding attempt
        // fails. Both addresses must be reported, because one unsweepable
        // deposit stranding every other user's funds would be far worse than
        // the failure itself.
        const account = privateKeyToAccount(generatePrivateKey());
        const brokeFunder = createWalletClient({ account, transport: http(rpcUrl) });
        assert.equal(await harness.publicClient.getBalance({ address: account.address }), 0n);

        const result = await runSweepsOnce({ ...deps, funder: brokeFunder }, config());

        assert.equal(result.planned, 2);
        assert.equal(result.swept, 0);
        assert.equal(result.failures.length, 2, "the loop must not abort on the first failure");
    });
});
