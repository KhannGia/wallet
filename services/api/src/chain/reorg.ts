import type { Hash, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";

/**
 * A deposit whose block is no longer the one the chain agrees on.
 *
 * Either the height now holds a different block, or the chain has shrunk past
 * it. In both cases the transfer this wallet recorded did not happen on the
 * canonical chain, and crediting it would be crediting money that does not
 * exist.
 */
export interface ReorgedDeposit {
    id: bigint;
    accountId: bigint;
    amount: bigint;
    status: "PENDING" | "CONFIRMED";
    blockNumber: bigint;
    recordedBlockHash: Hash;
    /** The hash now at that height, or null if the chain no longer reaches it. */
    canonicalBlockHash: Hash | null;
}

interface DepositRow {
    id: bigint;
    account_id: bigint;
    amount: bigint;
    status: "PENDING" | "CONFIRMED";
    block_number: bigint;
    block_hash: string;
}

/**
 * Returns the canonical hash at each height, or null where the chain does not
 * reach that far.
 *
 * Heights are deduplicated first: a busy block can hold many deposits, and
 * asking the node once per deposit would multiply the requests for no reason.
 */
async function canonicalHashes(
    client: PublicClient,
    heights: bigint[],
): Promise<Map<bigint, Hash | null>> {
    const unique = [...new Set(heights)];
    const head = await client.getBlockNumber();
    const resolved = new Map<bigint, Hash | null>();

    for (const height of unique) {
        if (height > head) {
            // The chain was rolled back past this height and has not caught up.
            resolved.set(height, null);
            continue;
        }

        try {
            const block = await client.getBlock({ blockNumber: height });
            resolved.set(height, block.hash);
        } catch {
            resolved.set(height, null);
        }
    }

    return resolved;
}

/**
 * Finds recorded deposits that the chain no longer agrees with.
 *
 * Only looks at or above `fromBlock`, which the caller sets to just past the
 * finalised point: below that a block cannot be replaced, and rechecking all of
 * history on every pass would be wasted work.
 *
 * Deposits already marked REORGED are skipped -- they have been dealt with.
 *
 * This function only reports. Reversing the ledger is deliberately separate, so
 * that detection can be exercised on its own and so a bug in reporting can
 * never move money by itself.
 */
export async function findReorgedDeposits(
    pool: Pool,
    client: PublicClient,
    options: { fromBlock: bigint },
): Promise<ReorgedDeposit[]> {
    const { rows } = await pool.query<DepositRow>(
        `SELECT id, account_id, amount, status, block_number, block_hash
           FROM chain_deposits
          WHERE block_number >= $1 AND status <> 'REORGED'
          ORDER BY block_number, log_index`,
        [options.fromBlock],
    );

    if (rows.length === 0) {
        return [];
    }

    const hashes = await canonicalHashes(
        client,
        rows.map((row) => row.block_number),
    );

    const reorged: ReorgedDeposit[] = [];

    for (const row of rows) {
        const canonical = hashes.get(row.block_number) ?? null;

        // Comparing hashes rather than heights is the whole point: a reorg
        // replaces a block while leaving its height occupied, so a
        // height-based check would notice nothing at all.
        if (canonical !== null && canonical.toLowerCase() === row.block_hash.toLowerCase()) {
            continue;
        }

        reorged.push({
            id: row.id,
            accountId: row.account_id,
            amount: row.amount,
            status: row.status,
            blockNumber: row.block_number,
            recordedBlockHash: row.block_hash as Hash,
            canonicalBlockHash: canonical,
        });
    }

    return reorged;
}
