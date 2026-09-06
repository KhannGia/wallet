import { Pool, types } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

// node-postgres hands BIGINT (int8) back as a string, because a JS number is
// only exact up to 2^53 and silently losing precision on a balance would be
// far worse than an awkward type. Money is BIGINT everywhere in this schema,
// so parse it into a real BigInt instead of leaving it as text: without this,
// `balance + amount` would concatenate two strings.
types.setTypeParser(types.builtins.INT8, (value) => BigInt(value));

export function createPool(connectionString: string): Pool {
    return new Pool({ connectionString, max: 20 });
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on
 * any thrown error. Every write to the ledger goes through here, so a failure
 * midway can never leave half a transfer behind.
 */
export async function withTransaction<T>(
    pool: Pool,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/** Returns the single expected row, or throws rather than yielding undefined. */
export function one<T extends QueryResultRow>(rows: T[], what = "row"): T {
    const row = rows[0];
    if (row === undefined) {
        throw new Error(`Expected exactly one ${what}, got none`);
    }
    return row;
}

export type { Pool, PoolClient };
