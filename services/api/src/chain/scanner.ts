import type { Address, Hash, PublicClient } from "viem";

import { transferEvent } from "./erc20.ts";

/**
 * One incoming ERC-20 transfer, carrying everything needed to credit it once
 * and to undo it later if the chain reorganises.
 */
export interface IncomingTransfer {
    /** Uniquely identifies this log on the canonical chain. */
    transactionHash: Hash;
    logIndex: number;

    /** Kept so a reorg can be detected: the same height may hold a new hash. */
    blockNumber: bigint;
    blockHash: Hash;

    from: Address;
    to: Address;
    value: bigint;
}

export interface ScanRange {
    fromBlock: bigint;
    toBlock: bigint;
}

/**
 * Nodes cap how many blocks one eth_getLogs call may span, and the cap differs
 * per provider. Scanning in bounded chunks keeps a long catch-up -- an indexer
 * that has been down for a day -- from failing as a single oversized request.
 */
export const DEFAULT_CHUNK_SIZE = 2_000n;

/**
 * Reads ERC-20 transfers into any of `toAddresses` within a block range.
 *
 * The address filter is applied by the node through the indexed `to` topic,
 * not in JavaScript, so the response stays small no matter how busy the token
 * is. Both ends of the range are inclusive.
 */
export async function fetchIncomingTransfers(options: {
    client: PublicClient;
    token: Address;
    toAddresses: Address[];
    range: ScanRange;
    chunkSize?: bigint;
}): Promise<IncomingTransfer[]> {
    const { client, token, toAddresses, range } = options;
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    if (chunkSize <= 0n) {
        throw new Error(`chunkSize must be positive, got ${chunkSize}`);
    }
    if (range.toBlock < range.fromBlock) {
        throw new Error(`Empty range: ${range.fromBlock}..${range.toBlock}`);
    }
    // Filtering on an empty topic list matches everything rather than nothing,
    // so the caller would receive every transfer of the token.
    if (toAddresses.length === 0) {
        return [];
    }

    const found: IncomingTransfer[] = [];

    for (let start = range.fromBlock; start <= range.toBlock; start += chunkSize) {
        const end = start + chunkSize - 1n > range.toBlock ? range.toBlock : start + chunkSize - 1n;

        const logs = await client.getLogs({
            address: token,
            event: transferEvent,
            args: { to: toAddresses },
            fromBlock: start,
            toBlock: end,
        });

        for (const log of logs) {
            // A log still in the pending block has no position yet. Crediting
            // it would mean crediting something that may never be mined.
            if (
                log.blockNumber === null ||
                log.blockHash === null ||
                log.logIndex === null ||
                log.transactionHash === null
            ) {
                continue;
            }

            const { from, to, value } = log.args;
            if (from === undefined || to === undefined || value === undefined) {
                throw new Error(`Undecodable Transfer log in tx ${log.transactionHash}`);
            }

            found.push({
                transactionHash: log.transactionHash,
                logIndex: log.logIndex,
                blockNumber: log.blockNumber,
                blockHash: log.blockHash,
                from,
                to,
                value,
            });
        }
    }

    // Chain order, so a consumer processing them in sequence sees deposits in
    // the order the chain accepted them.
    found.sort((a, b) =>
        a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
    );

    return found;
}
