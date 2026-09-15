import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import { withTransaction, type Pool } from "../db/pool.ts";
import { bumpChainNonce, chainHarness, type ChainHarness } from "../test-support/chain.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { allocateNonce, peekNonce, registerHotWallet, syncNonceWithChain } from "./nonce.ts";

const WALLET = "hot";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

describe("nonce allocation", () => {
    let pool: Pool;
    let harness: ChainHarness;

    before(() => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
    });
    beforeEach(async () => {
        await resetDatabase(pool);
        await registerHotWallet(pool, WALLET, ADDRESS, 0n);
    });
    after(async () => {
        await pool.end();
    });

    const claim = () => withTransaction(pool, (client) => allocateNonce(client, WALLET));

    it("hands out a contiguous run with no duplicates under concurrency", async () => {
        // The acceptance criterion for P5. Asking the node for
        // eth_getTransactionCount instead would give every one of these the
        // same answer, and all but one transaction would be dropped.
        const nonces = await Promise.all(Array.from({ length: 20 }, claim));
        const sorted = [...nonces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        assert.equal(new Set(nonces).size, 20, "every nonce must be unique");
        assert.deepEqual(
            sorted,
            Array.from({ length: 20 }, (_unused, i) => BigInt(i)),
            "and they must be contiguous: a gap freezes every later transaction",
        );
        assert.equal(await peekNonce(pool, WALLET), 20n);
    });

    /** Waits until the given backend is provably parked on a lock. */
    const waitUntilBlocked = async (pid: number): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const { rows } = await pool.query<{ wait_event_type: string | null }>(
                "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
                [pid],
            );
            if (rows[0]?.wait_event_type === "Lock") return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`backend ${pid} never blocked on a lock`);
    };

    it("serialises two interleaved allocations", async () => {
        // The deterministic counterpart to the test above: both transactions
        // are held open by hand so the second is provably waiting when the
        // first commits. Twenty parallel requests from one Node process rarely
        // collide on their own.
        const first = await pool.connect();
        const second = await pool.connect();

        try {
            const { rows } = await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const secondPid = rows[0]?.pid;
            assert.ok(secondPid);

            await first.query("BEGIN");
            await second.query("BEGIN");

            const firstNonce = await allocateNonce(first, WALLET);

            const secondAttempt = allocateNonce(second, WALLET);
            await waitUntilBlocked(secondPid);

            await first.query("COMMIT");
            const secondNonce = await secondAttempt;
            await second.query("COMMIT");

            assert.equal(firstNonce, 0n);
            assert.equal(secondNonce, 1n, "the second allocation must see the first");
        } finally {
            first.release();
            second.release();
        }
    });

    it("returns the nonce when the surrounding transaction rolls back", async () => {
        // An allocated nonce that never reaches the chain blocks everything
        // queued behind it, so a failed withdrawal must not consume one.
        await assert.rejects(
            withTransaction(pool, async (client) => {
                await allocateNonce(client, WALLET);
                throw new Error("withdrawal failed after allocation");
            }),
            /withdrawal failed/,
        );

        assert.equal(await peekNonce(pool, WALLET), 0n, "the nonce must be reusable");
        assert.equal(await claim(), 0n);
    });

    it("refuses to allocate for a wallet that is not registered", async () => {
        await assert.rejects(
            withTransaction(pool, (client) => allocateNonce(client, "missing")),
            /not registered/,
        );
    });

    it("leaves the counter alone when it matches the chain", async () => {
        const count = await harness.publicClient.getTransactionCount({
            address: ADDRESS,
            blockTag: "pending",
        });
        await pool.query("UPDATE hot_wallets SET next_nonce = $2 WHERE id = $1", [
            WALLET,
            BigInt(count),
        ]);

        const result = await syncNonceWithChain(pool, WALLET, ADDRESS, harness.publicClient);

        assert.equal(result.action, "in_sync");
    });

    it("catches up when the chain has moved past the stored counter", async () => {
        // A restore from an older backup, or a second signer using the same
        // key. Reusing those nonces would produce transactions the node simply
        // rejects.
        //
        // The transaction is sent here rather than assumed: anvil gets
        // restarted, and a test resting on a count it did not create passes by
        // accident.
        const chainCount = await bumpChainNonce(harness);
        assert.ok(chainCount > 0n);
        await pool.query("UPDATE hot_wallets SET next_nonce = 0 WHERE id = $1", [WALLET]);

        const result = await syncNonceWithChain(pool, WALLET, ADDRESS, harness.publicClient);

        assert.equal(result.action, "advanced_to_chain");
        assert.equal(await peekNonce(pool, WALLET), result.chainCount);
    });

    it("never winds the counter back below what it has handed out", async () => {
        // Running ahead of the chain is normal while transactions are in
        // flight. Correcting it would reissue nonces already in the mempool.
        const count = await harness.publicClient.getTransactionCount({
            address: ADDRESS,
            blockTag: "pending",
        });
        const ahead = BigInt(count) + 5n;
        await pool.query("UPDATE hot_wallets SET next_nonce = $2 WHERE id = $1", [WALLET, ahead]);

        const result = await syncNonceWithChain(pool, WALLET, ADDRESS, harness.publicClient);

        assert.equal(result.action, "behind_chain_kept");
        assert.equal(await peekNonce(pool, WALLET), ahead);
    });
});
