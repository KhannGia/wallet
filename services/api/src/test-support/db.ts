import { loadEnv, xpubFromMnemonic } from "@wallet/shared";

import { createPool, type Pool } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
import { AccountNotFound } from "../ledger/errors.ts";
import { runIdempotent, type IdempotentOutcome } from "../ledger/idempotency.ts";
import { createUser, reconcile } from "../ledger/operations.ts";
import { postEntries } from "../ledger/postings.ts";
import { systemAccountId } from "../ledger/system-accounts.ts";

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
        "TRUNCATE vault_signatures, vault_proposals, chain_withdrawals, chain_deposits, ledger_entries, transactions, accounts, users, "
            + "indexer_state, hot_wallets, paymaster_sponsorships, smart_accounts, "
            + "recovery_signatures, recovery_requests, session_keys, graduations "
            + "RESTART IDENTITY CASCADE",
    );
    // TRUNCATE ... RESTART IDENTITY only resets sequences owned by the table's
    // own serial columns, not a standalone one, so it is restarted explicitly.
    await pool.query("ALTER SEQUENCE deposit_address_index_seq RESTART WITH 0");
    await pool.query(
        `INSERT INTO accounts (type, system_key)
         VALUES ('SYSTEM', 'BANK_GATEWAY'), ('SYSTEM', 'FEE_REVENUE'),
                ('SYSTEM', 'PENDING_DEPOSITS'), ('SYSTEM', 'PENDING_WITHDRAWALS')`,
    );
}

/** Fails the calling test unless the ledger still balances. */
export async function assertBalanced(pool: Pool): Promise<void> {
    const result = await reconcile(pool);
    if (!result.balanced) {
        throw new Error(
            `Ledger invariant broken: sum=${result.ledgerSum}, ` +
                `drift=${JSON.stringify(result.drift)}, ` +
                `parked=${JSON.stringify(result.parked)}`,
        );
    }
}

/**
 * Credits an account from BANK_GATEWAY, as if a deposit had arrived and become
 * final. A fixture, not a feature: the product has no way to create a balance
 * except a deposit the indexer sees on chain. Tests that only exercise the
 * ledger use this to skip the chain; nothing on chain backs these balances, so
 * proof-of-reserves tests fund accounts through real deposits instead.
 */
export async function creditForTest(
    pool: Pool,
    params: { accountId: bigint; amount: bigint; idempotencyKey: string },
): Promise<IdempotentOutcome<{ balance: string }>> {
    const body = { accountId: String(params.accountId), amount: String(params.amount) };
    return runIdempotent(pool, { key: params.idempotencyKey, kind: "DEPOSIT", body }, async (client, txId) => {
        const gateway = await systemAccountId(client, "BANK_GATEWAY");
        const entries = await postEntries(client, txId, [
            { accountId: gateway, amount: -params.amount },
            { accountId: params.accountId, amount: params.amount },
        ]);
        const credited = entries.find((entry) => entry.accountId === params.accountId);
        if (credited === undefined) throw new AccountNotFound(params.accountId);
        return { balance: String(credited.balanceAfter) };
    });
}

export async function seedAccount(pool: Pool, email: string, balance: bigint): Promise<bigint> {
    // Goes through createUser rather than raw INSERTs so seeded accounts get a
    // derivation index and deposit address like real ones, and the schema
    // constraints are exercised by the tests too.
    const created = await createUser(pool, { email, xpub: TEST_XPUB });
    const accountId = BigInt(created.accountId);

    if (balance > 0n) {
        await creditForTest(pool, {
            accountId,
            amount: balance,
            idempotencyKey: `seed-${accountId}-${balance}`,
        });
    }

    return accountId;
}
