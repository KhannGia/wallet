import type { PoolClient } from "pg";

import { one } from "../db/pool.ts";
import { AccountNotFound, InsufficientFunds, UnbalancedPostings } from "./errors.ts";

/** One side of a transaction: negative debits the account, positive credits it. */
export interface Posting {
    accountId: bigint;
    amount: bigint;
}

export interface WrittenEntry {
    id: bigint;
    accountId: bigint;
    amount: bigint;
    balanceAfter: bigint;
}

interface AccountRow {
    id: bigint;
    type: "USER" | "SYSTEM";
    balance: bigint;
}

/**
 * The only way money moves in this system.
 *
 * Every caller -- deposits, withdrawals, transfers, and on-chain settlement
 * later -- funnels through here, so the double-entry invariant is enforced in
 * exactly one place instead of being re-implemented per endpoint.
 *
 * Must be called inside a transaction; it takes row locks it expects the
 * caller to release by committing.
 */
export async function postEntries(
    client: PoolClient,
    transactionId: bigint,
    postings: Posting[],
): Promise<WrittenEntry[]> {
    if (postings.length < 2) {
        throw new UnbalancedPostings(0n);
    }

    const total = postings.reduce((sum, posting) => sum + posting.amount, 0n);
    if (total !== 0n) {
        throw new UnbalancedPostings(total);
    }

    // Collapse repeats so one account cannot be locked twice in a single call,
    // which would otherwise deadlock against itself on some paths.
    const netByAccount = new Map<bigint, bigint>();
    for (const posting of postings) {
        netByAccount.set(posting.accountId, (netByAccount.get(posting.accountId) ?? 0n) + posting.amount);
    }

    // Lock in ascending account id, always. Two concurrent transfers in
    // opposite directions (A->B and B->A) would otherwise each hold the lock
    // the other is waiting for, and deadlock. A fixed global order makes that
    // impossible.
    const accountIds = [...netByAccount.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const locked = new Map<bigint, AccountRow>();
    for (const accountId of accountIds) {
        const { rows } = await client.query<AccountRow>(
            "SELECT id, type, balance FROM accounts WHERE id = $1 FOR UPDATE",
            [accountId],
        );
        const account = rows[0];
        if (account === undefined) {
            throw new AccountNotFound(accountId);
        }
        locked.set(accountId, account);
    }

    const written: WrittenEntry[] = [];

    for (const accountId of accountIds) {
        const account = locked.get(accountId);
        if (account === undefined) {
            throw new AccountNotFound(accountId);
        }

        const amount = netByAccount.get(accountId) ?? 0n;
        if (amount === 0n) {
            // A net-zero movement leaves no trace worth recording, and the
            // schema rejects a zero-amount entry anyway.
            continue;
        }

        const balanceAfter = account.balance + amount;

        // System accounts are allowed to run negative: BANK_GATEWAY holding a
        // large negative balance is the money sitting at the partner bank.
        if (account.type === "USER" && balanceAfter < 0n) {
            throw new InsufficientFunds(accountId, account.balance, -amount);
        }

        const entry = one(
            (
                await client.query<{ id: bigint }>(
                    `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id`,
                    [transactionId, accountId, amount, balanceAfter],
                )
            ).rows,
            "ledger entry",
        );

        await client.query(
            "UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2",
            [balanceAfter, accountId],
        );

        written.push({ id: entry.id, accountId, amount, balanceAfter });
    }

    return written;
}
