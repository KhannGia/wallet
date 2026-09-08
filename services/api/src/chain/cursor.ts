import type { Pool, PoolClient } from "../db/pool.ts";
import { one } from "../db/pool.ts";

/** Identifies one logical scanner, so several can run without colliding. */
export type ScannerId = string;

/**
 * Returns where this scanner should resume, creating the row at `startBlock`
 * the first time it runs.
 *
 * A missing cursor must never be treated as "start from the current block":
 * that would silently skip every deposit that arrived while the indexer was
 * down, and the money would be on-chain with no ledger entry to match.
 */
export async function loadCursor(
    db: Pool | PoolClient,
    id: ScannerId,
    startBlock: bigint,
): Promise<bigint> {
    const { rows } = await db.query<{ last_scanned_block: bigint }>(
        `INSERT INTO indexer_state (id, last_scanned_block)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING last_scanned_block`,
        [id, startBlock],
    );

    return one(rows, "indexer cursor").last_scanned_block;
}

/**
 * Advances the cursor.
 *
 * Only ever moves forward: a scan that reported an older block would rewind
 * the indexer and cause deposits to be processed twice. Rewinding after a
 * reorg is a separate, deliberate operation (P4), not something a normal scan
 * should be able to do by accident.
 */
export async function advanceCursor(
    db: Pool | PoolClient,
    id: ScannerId,
    block: bigint,
): Promise<void> {
    await db.query(
        `UPDATE indexer_state
            SET last_scanned_block = GREATEST(last_scanned_block, $2), updated_at = now()
          WHERE id = $1`,
        [id, block],
    );
}
