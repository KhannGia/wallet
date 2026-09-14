import type { Address, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";
import {
    confirmDepositsThrough,
    recordPendingDeposit,
    reverseDeposit,
} from "../ledger/deposits.ts";
import { advanceCursor, loadCursor, rewindCursor } from "./cursor.ts";
import { finalisedThrough, type FinalityStrategy } from "./finality.ts";
import { findReorgedDeposits } from "./reorg.ts";
import { fetchIncomingTransfers } from "./scanner.ts";

export interface IndexerConfig {
    scannerId: string;
    token: Address;
    startBlock: bigint;
    finality: FinalityStrategy;
    chunkSize?: bigint;

    /**
     * Caps how far one pass advances. A wallet that has been offline for a week
     * would otherwise try to scan the whole gap before recording anything, and
     * a crash partway would leave nothing to show for the work.
     */
    maxBlocksPerRun?: bigint;
}

export interface IndexerRunResult {
    scannedFrom: bigint | null;
    scannedTo: bigint | null;
    recorded: number;
    confirmed: number;
    reversed: number;
    /** Reorged deposits an operator has to deal with; see reverseDeposit. */
    needsReview: string[];
    cursor: bigint;
}

/** Every deposit address this wallet is watching. */
async function watchedAddresses(pool: Pool): Promise<Address[]> {
    // Fine while the wallet has thousands of accounts. Beyond that this becomes
    // a paged query, or the filter moves to a bloom check against the block.
    const { rows } = await pool.query<{ deposit_address: string }>(
        "SELECT deposit_address FROM accounts WHERE type = 'USER' AND deposit_address IS NOT NULL",
    );

    return rows.map((row) => row.deposit_address as Address);
}

/**
 * One pass: scan new blocks, park what was found, then release whatever has
 * since become final.
 *
 * The cursor advances only after the deposits in a range have been recorded.
 * Advancing first and crashing would skip them permanently, whereas recording
 * first and crashing merely rescans a range -- which is harmless, because
 * recording is idempotent on the log's own identity. At-least-once is the only
 * safe direction to fail in.
 */
export async function runIndexerOnce(
    deps: { pool: Pool; client: PublicClient },
    config: IndexerConfig,
): Promise<IndexerRunResult> {
    const { pool, client } = deps;

    const finalThrough = await finalisedThrough(client, config.finality);

    // Reorgs are handled before scanning. Reading new blocks first would
    // advance the cursor past a range whose replacements have not been read,
    // and those transfers would never be seen again.
    const unfinalisedFrom = finalThrough === null ? config.startBlock : finalThrough + 1n;
    const reorged = await findReorgedDeposits(pool, client, { fromBlock: unfinalisedFrom });

    let reversed = 0;
    const needsReview: string[] = [];
    let earliestReorged: bigint | null = null;

    for (const deposit of reorged) {
        const outcome = await reverseDeposit(pool, deposit);

        if (outcome.kind === "reversed") {
            reversed += 1;
        } else {
            needsReview.push(outcome.reason);
        }

        if (earliestReorged === null || deposit.blockNumber < earliestReorged) {
            earliestReorged = deposit.blockNumber;
        }
    }

    if (earliestReorged !== null) {
        // Rewind so the replacement blocks are read. The transfers may reappear
        // at a different height, or not at all; either way the chain, not the
        // old record, decides.
        await rewindCursor(pool, config.scannerId, earliestReorged - 1n);
    }

    const cursor = await loadCursor(pool, config.scannerId, config.startBlock);
    const head = await client.getBlockNumber();

    let scannedFrom: bigint | null = null;
    let scannedTo: bigint | null = null;
    let recorded = 0;

    if (head > cursor) {
        const maxBlocks = config.maxBlocksPerRun ?? 10_000n;
        const fromBlock = cursor + 1n;
        const toBlock = head - fromBlock + 1n > maxBlocks ? fromBlock + maxBlocks - 1n : head;

        const addresses = await watchedAddresses(pool);

        const transfers = await fetchIncomingTransfers({
            client,
            token: config.token,
            toAddresses: addresses,
            range: { fromBlock, toBlock },
            ...(config.chunkSize === undefined ? {} : { chunkSize: config.chunkSize }),
        });

        for (const transfer of transfers) {
            const result = await recordPendingDeposit(pool, transfer, config.token);
            if (result !== null) {
                recorded += 1;
            }
        }

        await advanceCursor(pool, config.scannerId, toBlock);
        scannedFrom = fromBlock;
        scannedTo = toBlock;
    }

    // Confirmation is independent of scanning: blocks become final with time,
    // not with new deposits, so this runs even when nothing new was scanned.
    const confirmed =
        finalThrough === null ? [] : await confirmDepositsThrough(pool, finalThrough);

    return {
        scannedFrom,
        scannedTo,
        recorded,
        confirmed: confirmed.length,
        reversed,
        needsReview,
        cursor: await loadCursor(pool, config.scannerId, config.startBlock),
    };
}
