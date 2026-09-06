import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { withTransaction, type Pool } from "../db/pool.ts";
import { assertBalanced, resetDatabase, seedAccount, testPool } from "../test-support/db.ts";
import { InsufficientFunds, UnbalancedPostings } from "./errors.ts";
import { postEntries } from "./postings.ts";
import { deposit, reconcile, transfer, withdraw } from "./operations.ts";

describe("double-entry postings", () => {
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

    it("rejects postings that do not sum to zero", async () => {
        const account = await seedAccount(pool, "a@test", 0n);

        await assert.rejects(
            withTransaction(pool, async (client) => {
                const { rows } = await client.query<{ id: bigint }>(
                    `INSERT INTO transactions (idempotency_key, request_fingerprint, kind)
                     VALUES ('unbalanced', 'x', 'DEPOSIT') RETURNING id`,
                );
                const tx = rows[0];
                assert.ok(tx);
                // Money would be created out of nothing here.
                await postEntries(client, tx.id, [{ accountId: account, amount: 500n }]);
            }),
            UnbalancedPostings,
        );

        await assertBalanced(pool);
    });

    it("credits a deposit and keeps the system in balance", async () => {
        const account = await seedAccount(pool, "b@test", 0n);

        const outcome = await deposit(pool, {
            accountId: account,
            amount: 100_000n,
            idempotencyKey: "dep-1",
        });

        assert.equal(outcome.result.balance, "100000");
        await assertBalanced(pool);

        // The gateway holds the mirror image: money owed to the partner bank.
        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE system_key = 'BANK_GATEWAY'",
        );
        assert.equal(rows[0]?.balance, -100_000n);
    });

    it("refuses to overdraw a user account", async () => {
        const account = await seedAccount(pool, "c@test", 100n);

        await assert.rejects(
            withdraw(pool, { accountId: account, amount: 101n, idempotencyKey: "wd-1" }),
            InsufficientFunds,
        );

        const check = await reconcile(pool);
        assert.equal(check.balanced, true);
        assert.equal(check.ledgerSum, "0");
    });

    it("moves money between users without changing the total", async () => {
        const alice = await seedAccount(pool, "alice@test", 1_000n);
        const bob = await seedAccount(pool, "bob@test", 0n);

        await transfer(pool, {
            fromAccountId: alice,
            toAccountId: bob,
            amount: 400n,
            idempotencyKey: "tr-1",
        });

        const { rows } = await pool.query<{ id: bigint; balance: bigint }>(
            "SELECT id, balance FROM accounts WHERE id = ANY($1) ORDER BY id",
            [[alice, bob]],
        );
        assert.equal(rows[0]?.balance, 600n);
        assert.equal(rows[1]?.balance, 400n);
        await assertBalanced(pool);
    });

    it("keeps ledger_entries append-only", async () => {
        const account = await seedAccount(pool, "d@test", 50n);
        assert.ok(account);

        await assert.rejects(
            pool.query("UPDATE ledger_entries SET amount = 999 WHERE id = 1"),
            /append-only/,
        );
        await assert.rejects(pool.query("DELETE FROM ledger_entries WHERE id = 1"), /append-only/);
    });

    it("stores BIGINT balances as BigInt, not string", async () => {
        // Without the int8 type parser this returns "50" and arithmetic silently
        // becomes string concatenation.
        const account = await seedAccount(pool, "e@test", 50n);
        const { rows } = await pool.query<{ balance: bigint }>(
            "SELECT balance FROM accounts WHERE id = $1",
            [account],
        );
        assert.equal(typeof rows[0]?.balance, "bigint");
    });
});
