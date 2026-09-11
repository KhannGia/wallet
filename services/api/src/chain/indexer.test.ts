import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { createUser, getAccount } from "../ledger/operations.ts";
import { pendingBalance } from "../ledger/deposits.ts";
import { chainHarness, deployMockUsdc, mintTo, type ChainHarness } from "../test-support/chain.ts";
import { assertBalanced, resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { runIndexerOnce } from "./indexer.ts";
import type { IndexerConfig } from "./indexer.ts";

describe("indexer", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let token: Address;

    // A depth of one means the head block itself counts as final, which keeps
    // these tests from waiting on anvil's two-second blocks. anvil pins its
    // `finalized` tag to genesis forever, so the tag strategy cannot be used
    // against a devnet at all.
    const config = (over: Partial<IndexerConfig> = {}): IndexerConfig => ({
        scannerId: "usdc",
        token,
        startBlock: 0n,
        finality: { kind: "confirmations", depth: 1n },
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
    });
    after(async () => {
        await pool.end();
    });

    const newAccount = async (email: string) => {
        const created = await createUser(pool, { email, xpub: TEST_XPUB });
        return { id: BigInt(created.accountId), address: created.depositAddress as Address };
    };

    const startAt = async (): Promise<bigint> => harness.publicClient.getBlockNumber();

    /** An address this wallet does not own. */
    const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;

    /**
     * Mines `count` blocks by sending transfers nobody is watching. Advancing
     * the chain with mints to a watched address would create extra deposits and
     * change the very balances under test.
     */
    const advanceChain = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i++) {
            await mintTo(harness, token, STRANGER, 1n);
        }
    };

    it("credits a deposit only once it is final", async () => {
        const account = await newAccount("depositor@test.local");
        const from = await startAt();

        await mintTo(harness, token, account.address, 1_500_000n);

        // Depth 3 means the transfer's block is not final yet.
        const first = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from, finality: { kind: "confirmations", depth: 3n } }),
        );

        assert.equal(first.recorded, 1);
        assert.equal(first.confirmed, 0, "must not credit a block that can still be reorganised");

        // The money exists in the ledger but is not the user's yet.
        assert.equal((await getAccount(pool, account.id)).balance, "0");
        assert.equal(await pendingBalance(pool, account.id), 1_500_000n);
        await assertBalanced(pool);

        // Let the chain move on without creating deposits of its own.
        await advanceChain(2);

        const second = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from, finality: { kind: "confirmations", depth: 3n } }),
        );

        assert.equal(second.confirmed, 1);
        assert.equal((await getAccount(pool, account.id)).balance, "1500000");
        assert.equal(await pendingBalance(pool, account.id), 0n);
        await assertBalanced(pool);
    });

    it("does not credit twice when a range is rescanned", async () => {
        const account = await newAccount("rescan@test.local");
        const from = await startAt();

        await mintTo(harness, token, account.address, 900_000n);

        await runIndexerOnce({ pool, client: harness.publicClient }, config({ startBlock: from }));
        const balanceAfterFirst = (await getAccount(pool, account.id)).balance;

        // Rewind the cursor by hand, as a restart from an older checkpoint
        // would, and scan the same blocks again.
        await pool.query("UPDATE indexer_state SET last_scanned_block = $1 WHERE id = 'usdc'", [from]);

        await runIndexerOnce({ pool, client: harness.publicClient }, config({ startBlock: from }));

        assert.equal((await getAccount(pool, account.id)).balance, balanceAfterFirst);

        const { rows } = await pool.query<{ count: bigint }>(
            "SELECT COUNT(*) AS count FROM chain_deposits WHERE account_id = $1",
            [account.id],
        );
        assert.equal(rows[0]?.count, 1n, "the same log must produce one deposit row");
        await assertBalanced(pool);
    });

    it("ignores transfers to addresses the wallet does not own", async () => {
        await newAccount("owner@test.local");
        const from = await startAt();

        await mintTo(harness, token, STRANGER, 5_000_000n);

        const result = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from }),
        );

        assert.equal(result.recorded, 0);
        await assertBalanced(pool);
    });

    it("advances the cursor so the next pass starts after it", async () => {
        await newAccount("cursor@test.local");
        const from = await startAt();
        // Guarantees there is something to scan; otherwise the pass is a no-op
        // and the test would depend on anvil's block timer.
        await advanceChain(1);

        const result = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from }),
        );

        assert.ok(result.scannedTo !== null);
        assert.equal(result.cursor, result.scannedTo);

        const second = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from }),
        );
        assert.ok(second.scannedFrom === null || second.scannedFrom > result.scannedTo);
    });

    it("caps how far a single pass advances", async () => {
        await newAccount("capped@test.local");
        const from = await startAt();
        await advanceChain(2);

        const result = await runIndexerOnce(
            { pool, client: harness.publicClient },
            config({ startBlock: from, maxBlocksPerRun: 1n }),
        );

        assert.equal(result.scannedFrom, from + 1n);
        assert.equal(result.scannedTo, from + 1n, "one pass must not run past the cap");
    });

    it("keeps the ledger balanced through the whole lifecycle", async () => {
        const account = await newAccount("invariant@test.local");
        const from = await startAt();

        await mintTo(harness, token, account.address, 700_000n);
        await runIndexerOnce({ pool, client: harness.publicClient }, config({ startBlock: from }));
        await assertBalanced(pool);

        await runIndexerOnce({ pool, client: harness.publicClient }, config({ startBlock: from }));
        await assertBalanced(pool);

        // Nothing may be left parked once every deposit is final.
        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE system_key = 'PENDING_DEPOSITS'",
        );
        assert.equal(rows[0]?.balance, 0n);
    });
});
