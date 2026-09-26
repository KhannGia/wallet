import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { runIndexerOnce, type IndexerConfig } from "../chain/indexer.ts";
import { findReorgedDeposits } from "../chain/reorg.ts";
import {
    chainHarness,
    deployMockUsdc,
    reorgFromBlock,
    mineBlocks,
    mintTo,
    type ChainHarness,
} from "../test-support/chain.ts";
import { assertBalanced, resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { createUser, getAccount } from "./operations.ts";
import { pendingBalance, reverseDeposit } from "./deposits.ts";

describe("reorg reversal", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let token: Address;
    let tokenBlock: bigint;

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        token = await deployMockUsdc(harness);
        tokenBlock = await harness.publicClient.getBlockNumber();
        // A reorg rewrites state too, so keep the deployment out of reach.
        await mineBlocks(harness, 40);
    });
    beforeEach(async () => {
        await resetDatabase(pool);
        const code = await harness.publicClient.getCode({ address: token });
        assert.ok(code !== undefined && code !== "0x", "the token was reorged away");
    });
    after(async () => {
        await pool.end();
    });

    const config = (startBlock: bigint, depth: bigint): IndexerConfig => ({
        scannerId: "usdc",
        token,
        startBlock,
        finality: { kind: "confirmations", depth },
    });


    it("returns a reorged pending deposit to the gateway", async () => {
        const user = await createUser(pool, { email: "revert@test.local", xpub: TEST_XPUB });
        const accountId = BigInt(user.accountId);
        const from = await harness.publicClient.getBlockNumber();

        // A deep finality requirement keeps the deposit pending.
        await mintTo(harness, token, user.depositAddress as Address, 800_000n);
        await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        assert.equal(await pendingBalance(pool, accountId), 800_000n);

        const { rows } = await pool.query<{ block_number: bigint }>(
            "SELECT block_number FROM chain_deposits ORDER BY id DESC LIMIT 1",
        );
        const depositBlock = rows[0]?.block_number;
        assert.ok(depositBlock);

        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, depositBlock, tokenBlock);

        const result = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config(from, 100n),
        );

        assert.equal(result.reversed, 1);
        assert.deepEqual(result.needsReview, []);

        // Nothing was taken from the user, because nothing was ever given.
        assert.equal((await getAccount(pool, accountId)).balance, "0");
        assert.equal(await pendingBalance(pool, accountId), 0n);

        const { rows: pendingRows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE system_key = 'PENDING_DEPOSITS'",
        );
        assert.equal(pendingRows[0]?.balance, 0n, "the parked money went back out");
        await assertBalanced(pool);
    });

    it("marks the deposit reorged rather than deleting the record", async () => {
        const user = await createUser(pool, { email: "record@test.local", xpub: TEST_XPUB });
        const from = await harness.publicClient.getBlockNumber();

        await mintTo(harness, token, user.depositAddress as Address, 120_000n);
        await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        const { rows } = await pool.query<{ block_number: bigint }>(
            "SELECT block_number FROM chain_deposits ORDER BY id DESC LIMIT 1",
        );
        assert.ok(rows[0]);
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, rows[0].block_number, tokenBlock);
        await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        // History is evidence. A reorged deposit is marked, never erased.
        const { rows: after } = await pool.query<{ status: string; count: bigint }>(
            "SELECT status, COUNT(*) AS count FROM chain_deposits GROUP BY status",
        );
        assert.ok(after.some((row) => row.status === "REORGED"));
    });

    it("rewinds the cursor so the replacement blocks are read", async () => {
        const user = await createUser(pool, { email: "rewind@test.local", xpub: TEST_XPUB });
        const from = await harness.publicClient.getBlockNumber();

        await mintTo(harness, token, user.depositAddress as Address, 60_000n);
        const first = await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        const { rows } = await pool.query<{ block_number: bigint }>(
            "SELECT block_number FROM chain_deposits ORDER BY id DESC LIMIT 1",
        );
        const depositBlock = rows[0]?.block_number;
        assert.ok(depositBlock);

        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, depositBlock, tokenBlock);

        const second = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config(from, 100n),
        );

        // Without the rewind the scan would resume past the replaced range and
        // whatever the new blocks contain would never be seen.
        assert.ok(
            second.scannedFrom !== null && second.scannedFrom <= depositBlock,
            `expected a rescan from at or below ${depositBlock}, got ${second.scannedFrom}`,
        );
        assert.ok(first.cursor >= depositBlock);
    });

    it("refuses to claw back a confirmed deposit on its own", async () => {
        const user = await createUser(pool, { email: "confirmed@test.local", xpub: TEST_XPUB });
        const accountId = BigInt(user.accountId);
        const from = await harness.publicClient.getBlockNumber();

        await mintTo(harness, token, user.depositAddress as Address, 400_000n);
        // Depth 1 confirms immediately, putting the funds in the user's account.
        await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 1n));
        assert.equal((await getAccount(pool, accountId)).balance, "400000");

        const { rows } = await pool.query<{
            id: bigint;
            transaction_hash: string;
            log_index: number;
            amount: bigint;
            status: string;
        }>("SELECT id, transaction_hash, log_index, amount, status FROM chain_deposits LIMIT 1");
        const deposit = rows[0];
        assert.ok(deposit);
        assert.equal(deposit.status, "CONFIRMED");

        const outcome = await reverseDeposit(pool, {
            id: deposit.id,
            transactionHash: deposit.transaction_hash,
            logIndex: deposit.log_index,
            amount: deposit.amount,
            status: deposit.status,
        });

        // The funds are in a user account and may already be spent. Pushing a
        // real person negative is not a decision an unattended job should make.
        assert.equal(outcome.kind, "needs_review");
        assert.equal((await getAccount(pool, accountId)).balance, "400000");
        await assertBalanced(pool);
    });

    it("reverses only once when the same reorg is seen twice", async () => {
        const user = await createUser(pool, { email: "twice@test.local", xpub: TEST_XPUB });
        const from = await harness.publicClient.getBlockNumber();

        await mintTo(harness, token, user.depositAddress as Address, 300_000n);
        await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        const { rows } = await pool.query<{ block_number: bigint }>(
            "SELECT block_number FROM chain_deposits ORDER BY id DESC LIMIT 1",
        );
        assert.ok(rows[0]);
        await mineBlocks(harness, 3);
        await reorgFromBlock(harness, rows[0].block_number, tokenBlock);

        const first = await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));
        const second = await runIndexerOnce({ pool, client: harness.publicClient }, config(from, 100n));

        assert.equal(first.reversed, 1);
        assert.equal(second.reversed, 0, "an already-reversed deposit must not be reversed again");

        const stillReorged = await findReorgedDeposits(pool, harness.publicClient, {
            fromBlock: 0n,
        });
        assert.equal(
            stillReorged.some((d) => d.status === "PENDING"),
            false,
        );
        await assertBalanced(pool);
    });
});
