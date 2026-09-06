import { loadEnv } from "@wallet/shared";

import { createPool, type Pool } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
import { reconcile } from "../ledger/operations.ts";

export function testPool(): Pool {
    return createPool(loadEnv({ ...process.env, LOG_LEVEL: "error" }).DATABASE_URL);
}

/**
 * Truncates every table and restores the seeded system accounts.
 *
 * Concurrency tests spawn real parallel connections, so they cannot be wrapped
 * in a single transaction that gets rolled back -- the whole point is that the
 * writes are visible to each other. Truncation is the price of testing the
 * behaviour that actually matters.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
    await migrate(pool);
    await pool.query("TRUNCATE ledger_entries, transactions, accounts, users RESTART IDENTITY CASCADE");
    await pool.query(
        `INSERT INTO accounts (type, system_key)
         VALUES ('SYSTEM', 'BANK_GATEWAY'), ('SYSTEM', 'FEE_REVENUE')`,
    );
}

/** Fails the calling test unless the ledger still balances. */
export async function assertBalanced(pool: Pool): Promise<void> {
    const result = await reconcile(pool);
    if (!result.balanced) {
        throw new Error(
            `Ledger invariant broken: sum=${result.ledgerSum}, drift=${JSON.stringify(result.drift)}`,
        );
    }
}

export async function seedAccount(pool: Pool, email: string, balance: bigint): Promise<bigint> {
    const { rows: userRows } = await pool.query<{ id: bigint }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING id",
        [email],
    );
    const user = userRows[0];
    if (user === undefined) throw new Error("failed to seed user");

    const { rows: accountRows } = await pool.query<{ id: bigint }>(
        "INSERT INTO accounts (user_id, type) VALUES ($1, 'USER') RETURNING id",
        [user.id],
    );
    const account = accountRows[0];
    if (account === undefined) throw new Error("failed to seed account");

    if (balance > 0n) {
        const { deposit } = await import("../ledger/operations.ts");
        await deposit(pool, {
            accountId: account.id,
            amount: balance,
            idempotencyKey: `seed-${account.id}-${balance}`,
        });
    }

    return account.id;
}
