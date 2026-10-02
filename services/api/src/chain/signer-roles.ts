import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Pool } from "../db/pool.ts";

/** The hot wallet's row in hot_wallets, written by the withdrawal worker. */
export const HOT_WALLET_ID = "hot";

/**
 * Refuses any two roles that would sign from the same account.
 *
 * Every signing process manages its own nonces: the withdrawal worker
 * allocates them in the database, the others ask the node. Two processes on
 * one account hand out the same nonce, one transaction loses, and when the
 * loser is a payout it fails for no reason the payout itself could explain.
 * One account per process rules that out entirely.
 */
export function assertDistinctSigners(keys: Record<string, string | undefined>): void {
    const byAddress = new Map<Address, string[]>();
    for (const [role, key] of Object.entries(keys)) {
        if (key === undefined) continue;
        const address = privateKeyToAccount(key as Hex).address;
        byAddress.set(address, [...(byAddress.get(address) ?? []), role]);
    }

    const shared = [...byAddress.values()].filter((roles) => roles.length > 1);
    if (shared.length > 0) {
        throw new Error(
            `${shared.map((roles) => roles.join(" and ")).join("; ")} use the same key. ` +
                "Each signing process needs its own account, or their nonces collide.",
        );
    }
}

/**
 * The hot wallet's address, as the withdrawal worker registered it.
 *
 * Read from the database rather than configured separately: a second copy of
 * the address in configuration could drift from the key that actually controls
 * it, and the sweeper would then empty every deposit address into an account
 * nobody holds.
 */
export async function registeredHotWallet(pool: Pool): Promise<Address> {
    const { rows } = await pool.query<{ address: string }>(
        "SELECT address FROM hot_wallets WHERE id = $1",
        [HOT_WALLET_ID],
    );
    const row = rows[0];
    if (row === undefined) {
        throw new Error(
            "No hot wallet is registered yet. Start the withdrawal worker once " +
                "(./wallet withdrawer); it records the address it signs from.",
        );
    }
    return row.address as Address;
}

/**
 * Whether a gas funder is close to empty: fewer than `reserve` fundings left.
 * An empty funder does not lose anything, but every sweep that needs gas stalls
 * until someone tops it up, so it is worth hearing about before that happens.
 */
export function funderRunningLow(balance: bigint, fundingWei: bigint, reserve = 10n): boolean {
    return balance < fundingWei * reserve;
}
