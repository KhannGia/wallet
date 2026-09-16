import type { Address } from "viem";

import { one, type Pool } from "../db/pool.ts";
import { InsufficientFunds } from "./errors.ts";
import { runIdempotent } from "./idempotency.ts";
import { postEntries } from "./postings.ts";
import { systemAccountId } from "./system-accounts.ts";

/**
 * A withdrawal is the mirror of a deposit.
 *
 * Funds leave the user's account the moment one is requested and wait in
 * PENDING_WITHDRAWALS until the chain settles it, so the same balance cannot be
 * spent twice while a transaction is in flight. If the transaction fails they
 * come back out of that system account, which means the refund is always
 * funded -- it never has to invent money.
 */

export interface RequestedWithdrawal {
    withdrawalId: string;
    accountId: string;
    amount: string;
    balance: string;
    status: "PENDING";
}

export async function requestWithdrawal(
    pool: Pool,
    params: {
        accountId: bigint;
        to: Address;
        amount: bigint;
        tokenAddress: string;
        idempotencyKey: string;
    },
): Promise<RequestedWithdrawal> {
    const body = {
        accountId: String(params.accountId),
        to: params.to,
        amount: String(params.amount),
    };

    const outcome = await runIdempotent(
        pool,
        { key: params.idempotencyKey, kind: "WITHDRAWAL", body },
        async (client, ledgerTxId): Promise<RequestedWithdrawal> => {
            const reserve = await systemAccountId(client, "PENDING_WITHDRAWALS");

            // postEntries refuses to overdraw a user account, so an
            // over-request fails here rather than reaching the chain.
            const entries = await postEntries(client, ledgerTxId, [
                { accountId: params.accountId, amount: -params.amount },
                { accountId: reserve, amount: params.amount },
            ]);

            const debited = entries.find((entry) => entry.accountId === params.accountId);
            if (debited === undefined) {
                throw new InsufficientFunds(params.accountId, 0n, params.amount);
            }

            const withdrawal = one(
                (
                    await client.query<{ id: bigint }>(
                        `INSERT INTO chain_withdrawals
                             (account_id, to_address, token_address, amount,
                              status, reserved_transaction_id)
                         VALUES ($1, $2, $3, $4, 'PENDING', $5)
                         RETURNING id`,
                        [
                            params.accountId,
                            params.to,
                            params.tokenAddress,
                            params.amount,
                            ledgerTxId,
                        ],
                    )
                ).rows,
                "withdrawal",
            );

            return {
                withdrawalId: String(withdrawal.id),
                accountId: String(params.accountId),
                amount: String(params.amount),
                balance: String(debited.balanceAfter),
                status: "PENDING",
            };
        },
    );

    return outcome.result;
}

interface WithdrawalRow {
    id: bigint;
    account_id: bigint;
    amount: bigint;
    status: string;
}

async function loadWithdrawal(pool: Pool, withdrawalId: bigint): Promise<WithdrawalRow> {
    const { rows } = await pool.query<WithdrawalRow>(
        "SELECT id, account_id, amount, status FROM chain_withdrawals WHERE id = $1",
        [withdrawalId],
    );

    return one(rows, `withdrawal ${withdrawalId}`);
}

/** The transaction was mined successfully: the money has left the system. */
export async function settleWithdrawal(pool: Pool, withdrawalId: bigint): Promise<boolean> {
    const withdrawal = await loadWithdrawal(pool, withdrawalId);
    if (withdrawal.status === "CONFIRMED") {
        return false;
    }

    const outcome = await runIdempotent(
        pool,
        {
            key: `withdrawal-settle:${withdrawalId}`,
            kind: "WITHDRAWAL",
            body: { withdrawalId: String(withdrawalId) },
        },
        async (client, ledgerTxId) => {
            const reserve = await systemAccountId(client, "PENDING_WITHDRAWALS");
            const gateway = await systemAccountId(client, "BANK_GATEWAY");

            await postEntries(client, ledgerTxId, [
                { accountId: reserve, amount: -withdrawal.amount },
                { accountId: gateway, amount: withdrawal.amount },
            ]);

            await client.query(
                `UPDATE chain_withdrawals
                    SET status = 'CONFIRMED', settled_transaction_id = $2, settled_at = now()
                  WHERE id = $1 AND status <> 'CONFIRMED'`,
                [withdrawalId, ledgerTxId],
            );

            return true;
        },
    );

    return !outcome.replayed;
}

/**
 * The transaction failed. The reserved funds go back to the user.
 *
 * Always fundable: the money never left PENDING_WITHDRAWALS, so the refund is
 * a transfer out of a system account rather than a credit from nowhere.
 */
export async function refundWithdrawal(
    pool: Pool,
    withdrawalId: bigint,
    reason: string,
): Promise<boolean> {
    const withdrawal = await loadWithdrawal(pool, withdrawalId);
    if (withdrawal.status === "FAILED" || withdrawal.status === "CONFIRMED") {
        return false;
    }

    const outcome = await runIdempotent(
        pool,
        {
            key: `withdrawal-refund:${withdrawalId}`,
            kind: "REVERSAL",
            body: { withdrawalId: String(withdrawalId) },
        },
        async (client, ledgerTxId) => {
            const reserve = await systemAccountId(client, "PENDING_WITHDRAWALS");

            await postEntries(client, ledgerTxId, [
                { accountId: reserve, amount: -withdrawal.amount },
                { accountId: withdrawal.account_id, amount: withdrawal.amount },
            ]);

            await client.query(
                `UPDATE chain_withdrawals
                    SET status = 'FAILED', failure = $3,
                        settled_transaction_id = $2, settled_at = now()
                  WHERE id = $1 AND status NOT IN ('FAILED', 'CONFIRMED')`,
                [withdrawalId, ledgerTxId, reason],
            );

            return true;
        },
    );

    return !outcome.replayed;
}

/** Funds debited from a user but not yet settled on chain. */
export async function reservedBalance(pool: Pool, accountId: bigint): Promise<bigint> {
    const { rows } = await pool.query<{ total: bigint }>(
        `SELECT COALESCE(SUM(amount), 0)::BIGINT AS total
           FROM chain_withdrawals
          WHERE account_id = $1 AND status IN ('PENDING', 'SUBMITTED')`,
        [accountId],
    );

    return one(rows, "reserved balance").total;
}
