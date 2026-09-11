import type { Pool, PoolClient } from "../db/pool.ts";
import { one } from "../db/pool.ts";
import type { IncomingTransfer } from "../chain/scanner.ts";
import { runIdempotent } from "./idempotency.ts";
import { postEntries } from "./postings.ts";

/**
 * A deposit takes two steps into the ledger, and the split is the point.
 *
 * While the block it arrived in can still be reorganised away, the money is
 * held in the PENDING_DEPOSITS system account and the user's balance does not
 * move. Only once the block is final is it released to them. So a user's
 * balance always means "spendable", and undoing a reorged deposit never has to
 * take funds back from someone who already spent them.
 */

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

export interface RecordedDeposit {
    depositId: string;
    accountId: string;
    amount: string;
    status: "PENDING";
}

/**
 * Records a transfer seen on-chain and parks it in PENDING_DEPOSITS.
 *
 * Idempotent on the log's own identity. A block range rescanned after a restart
 * re-presents the same logs, and the chain already gives each one a unique
 * position, so no key has to be invented for it.
 *
 * Returns null when the transfer is to an address this wallet does not own,
 * which the scanner's filter should already prevent.
 */
export async function recordPendingDeposit(
    pool: Pool,
    transfer: IncomingTransfer,
    tokenAddress: string,
): Promise<RecordedDeposit | null> {
    const key = `chain-deposit:${transfer.transactionHash}:${transfer.logIndex}`;

    const outcome = await runIdempotent(
        pool,
        {
            key,
            kind: "DEPOSIT",
            body: { txHash: transfer.transactionHash, logIndex: transfer.logIndex },
            metadata: { blockNumber: String(transfer.blockNumber), blockHash: transfer.blockHash },
        },
        async (client, ledgerTxId): Promise<RecordedDeposit | null> => {
            const { rows } = await client.query<{ id: bigint }>(
                "SELECT id FROM accounts WHERE lower(deposit_address) = lower($1) AND type = 'USER'",
                [transfer.to],
            );
            const account = rows[0];
            if (account === undefined) {
                return null;
            }

            const gateway = await systemAccountId(client, "BANK_GATEWAY");
            const pending = await systemAccountId(client, "PENDING_DEPOSITS");

            // The user is deliberately not credited here.
            await postEntries(client, ledgerTxId, [
                { accountId: gateway, amount: -transfer.value },
                { accountId: pending, amount: transfer.value },
            ]);

            const deposit = one(
                (
                    await client.query<{ id: bigint }>(
                        `INSERT INTO chain_deposits (
                             transaction_hash, log_index, block_number, block_hash,
                             token_address, from_address, to_address, amount,
                             account_id, status, credited_transaction_id
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10)
                         RETURNING id`,
                        [
                            transfer.transactionHash,
                            transfer.logIndex,
                            transfer.blockNumber,
                            transfer.blockHash,
                            tokenAddress,
                            transfer.from,
                            transfer.to,
                            transfer.value,
                            account.id,
                            ledgerTxId,
                        ],
                    )
                ).rows,
                "chain deposit",
            );

            return {
                depositId: String(deposit.id),
                accountId: String(account.id),
                amount: String(transfer.value),
                status: "PENDING",
            };
        },
    );

    return outcome.result;
}

export interface ConfirmedDeposit {
    depositId: string;
    accountId: string;
    amount: string;
}

/**
 * Releases every pending deposit at or below `finalBlock` to its owner.
 *
 * Each release is its own idempotent ledger transaction, so a crash midway
 * leaves the already-released deposits released and the rest still pending,
 * rather than a half-applied batch.
 */
export async function confirmDepositsThrough(
    pool: Pool,
    finalBlock: bigint,
): Promise<ConfirmedDeposit[]> {
    const { rows: due } = await pool.query<{
        id: bigint;
        transaction_hash: string;
        log_index: number;
        account_id: bigint;
        amount: bigint;
    }>(
        `SELECT id, transaction_hash, log_index, account_id, amount
           FROM chain_deposits
          WHERE status = 'PENDING' AND block_number <= $1
          ORDER BY block_number, log_index`,
        [finalBlock],
    );

    const confirmed: ConfirmedDeposit[] = [];

    for (const row of due) {
        const outcome = await runIdempotent(
            pool,
            {
                key: `chain-confirm:${row.transaction_hash}:${row.log_index}`,
                kind: "DEPOSIT",
                body: { depositId: String(row.id) },
            },
            async (client, ledgerTxId): Promise<ConfirmedDeposit> => {
                const pending = await systemAccountId(client, "PENDING_DEPOSITS");

                await postEntries(client, ledgerTxId, [
                    { accountId: pending, amount: -row.amount },
                    { accountId: row.account_id, amount: row.amount },
                ]);

                await client.query(
                    `UPDATE chain_deposits
                        SET status = 'CONFIRMED',
                            confirmed_transaction_id = $2,
                            confirmed_at = now()
                      WHERE id = $1 AND status = 'PENDING'`,
                    [row.id, ledgerTxId],
                );

                return {
                    depositId: String(row.id),
                    accountId: String(row.account_id),
                    amount: String(row.amount),
                };
            },
        );

        if (!outcome.replayed) {
            confirmed.push(outcome.result);
        }
    }

    return confirmed;
}

/** Sum of deposits seen on-chain but not yet final, and so not yet spendable. */
export async function pendingBalance(pool: Pool, accountId: bigint): Promise<bigint> {
    const { rows } = await pool.query<{ total: bigint }>(
        `SELECT COALESCE(SUM(amount), 0)::BIGINT AS total
           FROM chain_deposits
          WHERE account_id = $1 AND status = 'PENDING'`,
        [accountId],
    );

    return one(rows, "pending balance").total;
}
