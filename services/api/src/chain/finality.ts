import type { PublicClient } from "viem";

/**
 * How to decide that a block can no longer be reorganised away.
 *
 * `finalized-tag` is the correct choice on a real network: post-Merge Ethereum
 * and the L2s that follow it expose a block that consensus has finalised, and
 * nothing short of a catastrophic failure reverts it.
 *
 * `confirmations` exists because a devnet has no consensus layer. anvil pins
 * both `safe` and `finalized` to genesis forever, so a wallet running against
 * it with the tag strategy would leave every deposit pending indefinitely.
 */
export type FinalityStrategy =
    | { kind: "finalized-tag" }
    | { kind: "confirmations"; depth: bigint };

/**
 * Returns the highest block considered final, or null when nothing is final yet
 * -- a chain shorter than the confirmation depth, for instance.
 */
export async function finalisedThrough(
    client: PublicClient,
    strategy: FinalityStrategy,
): Promise<bigint | null> {
    if (strategy.kind === "finalized-tag") {
        const block = await client.getBlock({ blockTag: "finalized" });
        return block.number;
    }

    const head = await client.getBlockNumber();
    if (head < strategy.depth) {
        return null;
    }

    // A block at exactly `depth` confirmations counts as final: the head itself
    // has one confirmation.
    return head - strategy.depth + 1n;
}
