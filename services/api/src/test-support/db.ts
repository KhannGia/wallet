import { loadEnv, xpubFromMnemonic } from "@wallet/shared";

import { createPool, type Pool } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
import { reconcile } from "../ledger/operations.ts";

/**
 * The public Foundry test mnemonic. Its xpub is fine to hardcode here: the
 * mnemonic is published in anvil's own banner and controls nothing.
 */
export const TEST_XPUB = xpubFromMnemonic(
    "test test test test test test test test test test test junk",
);

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
    await pool.query(
        "TRUNCATE chain_deposits, ledger_entries, transactions, accounts, users, indexer_state "
            + "RESTART IDENTITY CASCADE",
    );
    // TRUNCATE ... RESTART IDENTITY only resets sequences owned by the table's
    // own serial columns, not a standalone one, so it is restarted explicitly.
    await pool.query("ALTER SEQUENCE deposit_address_index_seq RESTART WITH 0");
    await pool.query(
        `INSERT INTO accounts (type, system_key)
         VALUES ('SYSTEM', 'BANK_GATEWAY'), ('SYSTEM', 'FEE_REVENUE'), ('SYSTEM', 'PENDING_DEPOSITS')`,
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
    // Goes through createUser rather than raw INSERTs so seeded accounts get a
    // derivation index and deposit address like real ones, and the schema
    // constraints are exercised by the tests too.
    const { createUser, deposit } = await import("../ledger/operations.ts");
    const created = await createUser(pool, { email, xpub: TEST_XPUB });
    const accountId = BigInt(created.accountId);

    if (balance > 0n) {
        await deposit(pool, {
            accountId,
            amount: balance,
            idempotencyKey: `seed-${accountId}-${balance}`,
        });
    }

    return accountId;
}
