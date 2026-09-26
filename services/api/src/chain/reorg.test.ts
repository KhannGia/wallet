import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { createUser } from "../ledger/operations.ts";
import {
    chainHarness,
    deployMockUsdc,
    reorgFromBlock,
    mineBlocks,
    mintTo,
    type ChainHarness,
} from "../test-support/chain.ts";
import { resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { runIndexerOnce } from "./indexer.ts";
import { findReorgedDeposits } from "./reorg.ts";

describe("reorg detection", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let token: Address;

    /** Block the token was deployed in; no reorg here may reach back this far. */
    let tokenBlock: bigint;

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        token = await deployMockUsdc(harness);
        tokenBlock = await harness.publicClient.getBlockNumber();

        // A reorg rewrites state, not just headers, so one deep enough would
        // erase this deployment -- and calls to a codeless address succeed
        // silently, leaving no transfer to index and a baffling failure.
        await mineBlocks(harness, 40);
    });

    beforeEach(async () => {
        await resetDatabase(pool);

        // Fails loudly if a reorg ever does reach the token, instead of leaving
        // a later assertion to fail for reasons that look unrelated.
        const code = await harness.publicClient.getCode({ address: token });
        assert.ok(
            code !== undefined && code !== "0x",
            "the token was reorged away; bury the deployment deeper",
        );
    });
    after(async () => {
        await pool.end();
    });


    /** Creates an account, deposits to it, and indexes the result. */
    const depositAndIndex = async (email: string, amount: bigint) => {
        const created = await createUser(pool, { email, xpub: TEST_XPUB });
        const from = await harness.publicClient.getBlockNumber();

        await mintTo(harness, token, created.depositAddress as Address, amount);

        await runIndexerOnce(
            { pool, client: harness.publicClient },
            {
                scannerId: "usdc",
                token,
                startBlock: from,
                finality: { kind: "confirmations", depth: 100n },
            },
        );

        const { rows } = await pool.query<{ id: bigint; block_number: bigint; block_hash: string }>(
            "SELECT id, block_number, block_hash FROM chain_deposits ORDER BY id DESC LIMIT 1",
        );
        const row = rows[0];
        assert.ok(row, "the deposit should have been recorded");
        return row;
    };

    it("notices when the block a deposit arrived in was replaced", async () => {
        const deposit = await depositAndIndex("reorged@test.local", 500_000n);

        // Bury the deposit, then rewrite every block from it onward.
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, deposit.block_number, tokenBlock);

        const found = await findReorgedDeposits(pool, harness.publicClient, { fromBlock: 0n });

        assert.equal(found.length, 1);
        assert.equal(found[0]?.id, deposit.id);
        assert.equal(found[0]?.recordedBlockHash, deposit.block_hash);
        assert.notEqual(found[0]?.canonicalBlockHash, deposit.block_hash);
    });

    it("compares hashes, not heights", async () => {
        const deposit = await depositAndIndex("hashcheck@test.local", 100_000n);
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, deposit.block_number, tokenBlock);

        const found = await findReorgedDeposits(pool, harness.publicClient, { fromBlock: 0n });

        // The height is still occupied after a reorg -- by a different block.
        // A check based on block numbers would see nothing wrong here at all.
        const head = await harness.publicClient.getBlockNumber();
        assert.ok(deposit.block_number <= head, "the height is still part of the chain");
        assert.equal(found.length, 1, "yet the deposit must still be flagged");
    });

    it("leaves a deposit alone while its block is unchanged", async () => {
        await depositAndIndex("stable@test.local", 250_000n);
        await mineBlocks(harness, 5);

        const found = await findReorgedDeposits(pool, harness.publicClient, { fromBlock: 0n });

        assert.deepEqual(found, []);
    });

    it("ignores anything below the block it is asked to start from", async () => {
        const deposit = await depositAndIndex("windowed@test.local", 700_000n);
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, deposit.block_number, tokenBlock);

        // Blocks below the finalised point cannot be replaced, so rechecking
        // them on every pass would be wasted work.
        const found = await findReorgedDeposits(pool, harness.publicClient, {
            fromBlock: deposit.block_number + 1n,
        });

        assert.deepEqual(found, []);
    });

    it("does not re-report a deposit already marked reorged", async () => {
        const deposit = await depositAndIndex("already@test.local", 300_000n);
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, deposit.block_number, tokenBlock);

        await pool.query("UPDATE chain_deposits SET status = 'REORGED' WHERE id = $1", [deposit.id]);

        const found = await findReorgedDeposits(pool, harness.publicClient, { fromBlock: 0n });

        assert.deepEqual(found, []);
    });
});
