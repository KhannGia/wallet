import type { Address, PublicClient } from "viem";

import { one, type Pool, type PoolClient } from "../db/pool.ts";

/**
 * Registers the wallet that signs outgoing transactions, seeding its nonce from
 * the chain. Safe to call on every boot.
 */
export async function registerHotWallet(
    db: Pool | PoolClient,
    id: string,
    address: Address,
    startNonce: bigint,
): Promise<void> {
    await db.query(
        `INSERT INTO hot_wallets (id, address, next_nonce)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, address, startNonce],
    );
}

/**
 * Hands out the next nonce.
 *
 * A single UPDATE ... RETURNING is deliberate. Postgres holds a row lock for
 * the duration of the statement, so two callers are serialised without any
 * explicit locking, and neither can read a value the other is about to claim.
 * Reading the current nonce and writing back nonce + 1 as two statements would
 * reintroduce exactly the race this table exists to remove.
 *
 * Must be called inside the caller's transaction. If that transaction rolls
 * back the increment rolls back with it and the nonce is handed out again --
 * which is the behaviour we want, because an allocated-but-never-broadcast
 * nonce blocks every transaction queued behind it.
 */
export async function allocateNonce(client: PoolClient, walletId: string): Promise<bigint> {
    const { rows } = await client.query<{ nonce: bigint }>(
        `UPDATE hot_wallets
            SET next_nonce = next_nonce + 1, updated_at = now()
          WHERE id = $1
      RETURNING next_nonce - 1 AS nonce`,
        [walletId],
    );

    const row = rows[0];
    if (row === undefined) {
        throw new Error(`Hot wallet ${walletId} is not registered`);
    }

    return row.nonce;
}

/** The nonce that would be handed out next, without claiming it. */
export async function peekNonce(db: Pool | PoolClient, walletId: string): Promise<bigint> {
    const { rows } = await db.query<{ next_nonce: bigint }>(
        "SELECT next_nonce FROM hot_wallets WHERE id = $1",
        [walletId],
    );

    return one(rows, `hot wallet ${walletId}`).next_nonce;
}

export interface NonceSync {
    chainCount: bigint;
    storedNext: bigint;
    action: "in_sync" | "advanced_to_chain" | "behind_chain_kept";
}

/**
 * Reconciles the stored nonce against the chain.
 *
 * The chain's transaction count only includes mined transactions, so during
 * normal operation the stored nonce runs ahead of it while transactions are in
 * flight. That is expected and must not be "corrected": winding the counter
 * back would reissue nonces already in the mempool.
 *
 * The counter is only ever moved forward, to cover the case where the wallet
 * sent transactions this database does not know about -- a restore from an old
 * backup, or a second signer using the same key.
 */
export async function syncNonceWithChain(
    pool: Pool,
    walletId: string,
    address: Address,
    client: PublicClient,
): Promise<NonceSync> {
    // "pending" counts what the node has accepted but not yet mined, which is
    // the closest the chain can get to "the next nonce that will be used".
    const chainCount = BigInt(
        await client.getTransactionCount({ address, blockTag: "pending" }),
    );

    const storedNext = await peekNonce(pool, walletId);

    if (storedNext === chainCount) {
        return { chainCount, storedNext, action: "in_sync" };
    }

    if (storedNext < chainCount) {
        await pool.query(
            "UPDATE hot_wallets SET next_nonce = $2, updated_at = now() WHERE id = $1",
            [walletId, chainCount],
        );
        return { chainCount, storedNext: chainCount, action: "advanced_to_chain" };
    }

    return { chainCount, storedNext, action: "behind_chain_kept" };
}
