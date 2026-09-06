import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Pool } from "../db/pool.ts";
import { assertBalanced, resetDatabase, seedAccount, testPool } from "../test-support/db.ts";
import { InsufficientFunds } from "./errors.ts";
import { deposit, transfer, withdraw } from "./operations.ts";
import { postEntries } from "./postings.ts";

/**
 * These are the tests P1 exists for. Each one fails if the row locking or the
 * lock ordering is removed, and none of them would catch anything if the
 * operations ran sequentially.
 */
describe("concurrency", () => {
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

    /**
     * Polls until the given backend is actually parked on a lock, so the test
     * never has to guess with a sleep. Without this signal the interleaving is
     * timing-dependent and the test passes or fails at random.
     */
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

    // The decisive lock test, and the only one here that is fully
    // deterministic. Two transactions are driven by hand so the second is
    // provably mid-flight -- confirmed via pg_stat_activity, not a sleep --
    // when the first commits.
    //
    // With SELECT ... FOR UPDATE the second blocks before reading, so after
    // the commit it sees a zero balance and is rejected. Without it, the
    // second reads a stale 100000, believes the funds are there, and overdraws
    // the account by a full balance.
    it("stops two interleaved transactions from spending the same balance twice", async () => {
        const account = await seedAccount(pool, "interleaved@test", 100_000n);
        const gateway = 1n;

        const first = await pool.connect();
        const second = await pool.connect();

        try {
            const { rows: pidRows } = await second.query<{ pid: number }>(
                "SELECT pg_backend_pid() AS pid",
            );
            const secondPid = pidRows[0]?.pid;
            assert.ok(secondPid);

            const openTransaction = async (client: typeof first, key: string): Promise<bigint> => {
                await client.query("BEGIN");
                const { rows } = await client.query<{ id: bigint }>(
                    `INSERT INTO transactions (idempotency_key, request_fingerprint, kind)
                     VALUES ($1, 'fp', 'WITHDRAWAL') RETURNING id`,
                    [key],
                );
                const row = rows[0];
                assert.ok(row);
                return row.id;
            };

            const firstTx = await openTransaction(first, "interleaved-1");
            const secondTx = await openTransaction(second, "interleaved-2");

            const drain = [
                { accountId: account, amount: -100_000n },
                { accountId: gateway, amount: 100_000n },
            ];

            // First withdraws the whole balance and holds its locks open.
            await postEntries(first, firstTx, drain);

            // Second starts while those locks are held. Not awaited yet: it has
            // to still be in flight when the first commits.
            const secondAttempt = postEntries(second, secondTx, drain);
            await waitUntilBlocked(secondPid);

            await first.query("COMMIT");

            await assert.rejects(secondAttempt, InsufficientFunds);
            await second.query("ROLLBACK");
        } finally {
            first.release();
            second.release();
        }

        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE id = $1",
            [account],
        );
        assert.equal(rows[0]?.balance, 0n, "account must not be overdrawn");
        await assertBalanced(pool);
    });

    // Smoke test for the acceptance criterion. Note it passes even without row
    // locking, because 20 requests driven from one Node process rarely collide
    // in the read-write window -- which is exactly why the deterministic test
    // above exists.
    it("lets exactly one of 20 simultaneous withdrawals succeed", async () => {
        const account = await seedAccount(pool, "race@test", 100_000n);

        // Every request tries to take the entire balance. Without SELECT FOR
        // UPDATE all 20 read 100000, all 20 decide it is enough, and the
        // account ends up deeply negative.
        const attempts = Array.from({ length: 20 }, (_unused, index) =>
            withdraw(pool, {
                accountId: account,
                amount: 100_000n,
                idempotencyKey: `race-${index}`,
            }).then(
                () => "ok" as const,
                () => "rejected" as const,
            ),
        );

        const results = await Promise.all(attempts);
        const succeeded = results.filter((result) => result === "ok").length;

        assert.equal(succeeded, 1, `expected exactly 1 success, got ${succeeded}`);

        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE id = $1",
            [account],
        );
        assert.equal(rows[0]?.balance, 0n);
        await assertBalanced(pool);
    });

    it("does not deadlock when transfers cross in opposite directions", async () => {
        const alice = await seedAccount(pool, "alice@race", 100_000n);
        const bob = await seedAccount(pool, "bob@race", 100_000n);

        // A->B and B->A at the same time is the classic deadlock: each holds
        // the row the other needs. Locking in ascending account id makes the
        // ordering global, so one simply waits for the other.
        const rounds = 25;
        const transfers = Array.from({ length: rounds }, (_unused, index) => [
            transfer(pool, {
                fromAccountId: alice,
                toAccountId: bob,
                amount: 10n,
                idempotencyKey: `ab-${index}`,
            }),
            transfer(pool, {
                fromAccountId: bob,
                toAccountId: alice,
                amount: 10n,
                idempotencyKey: `ba-${index}`,
            }),
        ]).flat();

        const settled = await Promise.allSettled(transfers);
        const failures = settled.filter((result) => result.status === "rejected");

        assert.equal(failures.length, 0, `deadlocked or errored: ${JSON.stringify(failures.slice(0, 2))}`);

        // Equal traffic both ways, so the balances must be unchanged.
        const { rows } = await pool.query<{ id: bigint; balance: bigint }>(
            "SELECT id, balance FROM accounts WHERE id = ANY($1) ORDER BY id",
            [[alice, bob]],
        );
        assert.equal(rows[0]?.balance, 100_000n);
        assert.equal(rows[1]?.balance, 100_000n);
        await assertBalanced(pool);
    });

    it("creates one transaction when the same idempotency key arrives 10 times at once", async () => {
        const account = await seedAccount(pool, "idem@race", 0n);

        const attempts = Array.from({ length: 10 }, () =>
            deposit(pool, { accountId: account, amount: 5_000n, idempotencyKey: "same-key" }),
        );

        const outcomes = await Promise.all(attempts);

        assert.equal(outcomes.filter((outcome) => !outcome.replayed).length, 1);
        assert.equal(outcomes.filter((outcome) => outcome.replayed).length, 9);

        // The decisive assertion: the money moved once, not ten times.
        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE id = $1",
            [account],
        );
        assert.equal(rows[0]?.balance, 5_000n);

        const { rows: txRows } = await pool.query<{ count: bigint }>(
            "SELECT COUNT(*) AS count FROM transactions WHERE idempotency_key = 'same-key'",
        );
        assert.equal(txRows[0]?.count, 1n);
        await assertBalanced(pool);
    });
});
