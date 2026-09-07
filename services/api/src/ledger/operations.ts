import type { Pool, PoolClient } from "pg";

import { deriveDepositAddress } from "@wallet/shared";

import { one } from "../db/pool.ts";
import { AccountNotFound } from "./errors.ts";
import { runIdempotent, type IdempotentOutcome } from "./idempotency.ts";
import { postEntries } from "./postings.ts";

/**
 * Amounts cross the API boundary as strings, never JSON numbers. A JSON number
 * is an IEEE-754 double and loses precision above 2^53, which is a silent way
 * to corrupt a balance.
 */
export interface MoneyMovement {
    transactionId: string;
    accountId: string;
    amount: string;
    balance: string;
}

async function systemAccountId(client: PoolClient, key: string): Promise<bigint> {
    const { rows } = await client.query<{ id: bigint }>(
        "SELECT id FROM accounts WHERE system_key = $1",
        [key],
    );
    const row = rows[0];
    if (row === undefined) {
        throw new Error(`System account ${key} is missing; run migrations`);
    }
    return row.id;
}

export interface CreatedUser {
    userId: string;
    accountId: string;
    depositAddress: string;
    derivationIndex: string;
}

export async function createUser(
    pool: Pool,
    params: { email: string; xpub: string },
): Promise<CreatedUser> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const user = one(
            (
                await client.query<{ id: bigint }>(
                    "INSERT INTO users (email) VALUES ($1) RETURNING id",
                    [params.email],
                )
            ).rows,
            "user",
        );

        // nextval is safe under concurrency without a lock, so two signups
        // landing at the same instant can never share a derivation index --
        // which would mean two users sharing one deposit address, and their
        // funds becoming indistinguishable.
        const allocated = one(
            (
                await client.query<{ index: bigint }>(
                    "SELECT nextval('deposit_address_index_seq') AS index",
                )
            ).rows,
            "derivation index",
        );

        const derivationIndex = Number(allocated.index);
        const depositAddress = deriveDepositAddress(params.xpub, derivationIndex);

        const account = one(
            (
                await client.query<{ id: bigint }>(
                    `INSERT INTO accounts (user_id, type, derivation_index, deposit_address)
                     VALUES ($1, 'USER', $2, $3)
                     RETURNING id`,
                    [user.id, allocated.index, depositAddress],
                )
            ).rows,
            "account",
        );

        await client.query("COMMIT");
        return {
            userId: String(user.id),
            accountId: String(account.id),
            depositAddress,
            derivationIndex: String(allocated.index),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function deposit(
    pool: Pool,
    params: { accountId: bigint; amount: bigint; idempotencyKey: string },
): Promise<IdempotentOutcome<MoneyMovement>> {
    const body = { accountId: String(params.accountId), amount: String(params.amount) };

    return runIdempotent(pool, { key: params.idempotencyKey, kind: "DEPOSIT", body }, async (client, txId) => {
        const gateway = await systemAccountId(client, "BANK_GATEWAY");

        // The gateway is debited so the two sides sum to zero: the money is
        // modelled as moving in from the partner bank, not appearing.
        const entries = await postEntries(client, txId, [
            { accountId: gateway, amount: -params.amount },
            { accountId: params.accountId, amount: params.amount },
        ]);

        const credited = entries.find((entry) => entry.accountId === params.accountId);
        if (credited === undefined) {
            throw new AccountNotFound(params.accountId);
        }

        return {
            transactionId: String(txId),
            accountId: String(params.accountId),
            amount: String(params.amount),
            balance: String(credited.balanceAfter),
        };
    });
}

export async function withdraw(
    pool: Pool,
    params: { accountId: bigint; amount: bigint; idempotencyKey: string },
): Promise<IdempotentOutcome<MoneyMovement>> {
    const body = { accountId: String(params.accountId), amount: String(params.amount) };

    return runIdempotent(pool, { key: params.idempotencyKey, kind: "WITHDRAWAL", body }, async (client, txId) => {
        const gateway = await systemAccountId(client, "BANK_GATEWAY");

        const entries = await postEntries(client, txId, [
            { accountId: params.accountId, amount: -params.amount },
            { accountId: gateway, amount: params.amount },
        ]);

        const debited = entries.find((entry) => entry.accountId === params.accountId);
        if (debited === undefined) {
            throw new AccountNotFound(params.accountId);
        }

        return {
            transactionId: String(txId),
            accountId: String(params.accountId),
            amount: String(params.amount),
            balance: String(debited.balanceAfter),
        };
    });
}

export async function transfer(
    pool: Pool,
    params: { fromAccountId: bigint; toAccountId: bigint; amount: bigint; idempotencyKey: string },
): Promise<IdempotentOutcome<MoneyMovement>> {
    const body = {
        fromAccountId: String(params.fromAccountId),
        toAccountId: String(params.toAccountId),
        amount: String(params.amount),
    };

    return runIdempotent(pool, { key: params.idempotencyKey, kind: "TRANSFER", body }, async (client, txId) => {
        const entries = await postEntries(client, txId, [
            { accountId: params.fromAccountId, amount: -params.amount },
            { accountId: params.toAccountId, amount: params.amount },
        ]);

        const debited = entries.find((entry) => entry.accountId === params.fromAccountId);
        if (debited === undefined) {
            throw new AccountNotFound(params.fromAccountId);
        }

        return {
            transactionId: String(txId),
            accountId: String(params.fromAccountId),
            amount: String(params.amount),
            balance: String(debited.balanceAfter),
        };
    });
}

export async function getAccount(
    pool: Pool,
    accountId: bigint,
): Promise<{
    id: string;
    type: string;
    balance: string;
    currency: string;
    depositAddress: string | null;
}> {
    const { rows } = await pool.query<{
        id: bigint;
        type: string;
        balance: bigint;
        currency: string;
        deposit_address: string | null;
    }>(
        "SELECT id, type, balance, currency, deposit_address FROM accounts WHERE id = $1",
        [accountId],
    );

    const account = rows[0];
    if (account === undefined) {
        throw new AccountNotFound(accountId);
    }

    return {
        id: String(account.id),
        type: account.type,
        balance: String(account.balance),
        currency: account.currency,
        depositAddress: account.deposit_address,
    };
}

export interface EntryPage {
    entries: { id: string; transactionId: string; amount: string; balanceAfter: string; createdAt: string }[];
    nextCursor: string | null;
}

/**
 * Cursor pagination, not OFFSET. OFFSET rescans and skips every preceding row,
 * so it gets slower the deeper you page, and rows shifting underneath change
 * what page 2 contains.
 */
export async function listEntries(
    pool: Pool,
    accountId: bigint,
    options: { cursor?: bigint; limit: number },
): Promise<EntryPage> {
    const { rows } = await pool.query<{
        id: bigint;
        transaction_id: bigint;
        amount: bigint;
        balance_after: bigint;
        created_at: Date;
    }>(
        `SELECT id, transaction_id, amount, balance_after, created_at
           FROM ledger_entries
          WHERE account_id = $1 AND ($2::BIGINT IS NULL OR id < $2)
          ORDER BY id DESC
          LIMIT $3`,
        [accountId, options.cursor ?? null, options.limit + 1],
    );

    const page = rows.slice(0, options.limit);
    const last = page.at(-1);

    return {
        entries: page.map((row) => ({
            id: String(row.id),
            transactionId: String(row.transaction_id),
            amount: String(row.amount),
            balanceAfter: String(row.balance_after),
            createdAt: row.created_at.toISOString(),
        })),
        nextCursor: rows.length > options.limit && last !== undefined ? String(last.id) : null,
    };
}

export interface Reconciliation {
    balanced: boolean;
    ledgerSum: string;
    drift: { accountId: string; cachedBalance: string; entrySum: string }[];
}

/**
 * Proves two things the whole ledger rests on: that entries sum to zero across
 * the system, and that no account's cached balance has drifted from the sum of
 * its own entries.
 */
export async function reconcile(pool: Pool): Promise<Reconciliation> {
    const total = one(
        (
            await pool.query<{ total: bigint }>(
                // SUM() over BIGINT returns NUMERIC in Postgres, which the int8
                // parser does not touch -- without the cast this comes back as
                // the string "0" and every BigInt comparison silently fails.
                "SELECT COALESCE(SUM(amount), 0)::BIGINT AS total FROM ledger_entries",
            )
        ).rows,
        "ledger sum",
    );

    const { rows: drift } = await pool.query<{
        id: bigint;
        balance: bigint;
        entry_sum: bigint;
    }>(
        `SELECT a.id, a.balance, COALESCE(SUM(e.amount), 0)::BIGINT AS entry_sum
           FROM accounts a
           LEFT JOIN ledger_entries e ON e.account_id = a.id
          GROUP BY a.id, a.balance
         HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
    );

    return {
        balanced: total.total === 0n && drift.length === 0,
        ledgerSum: String(total.total),
        drift: drift.map((row) => ({
            accountId: String(row.id),
            cachedBalance: String(row.balance),
            entrySum: String(row.entry_sum),
        })),
    };
}
