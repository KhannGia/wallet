import type { PoolClient } from "../db/pool.ts";

/**
 * The book-keeping counterparties. None of them belongs to a user, and all are
 * expected to run negative -- BANK_GATEWAY holding a large negative balance is
 * the money held at the partner bank, not a bug.
 */
export type SystemAccount =
    | "BANK_GATEWAY"
    | "FEE_REVENUE"
    | "PENDING_DEPOSITS"
    | "PENDING_WITHDRAWALS";

export async function systemAccountId(
    client: PoolClient,
    key: SystemAccount,
): Promise<bigint> {
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
