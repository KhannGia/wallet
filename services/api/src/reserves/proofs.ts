import { buildSumTree, proveLeaf, type SumNode, type SumProof } from "@wallet/shared";
import type { Hex } from "viem";

import type { Pool } from "../db/pool.ts";
import { NoTreeForSnapshot, NotInSnapshot, ReservesSnapshotNotFound } from "./errors.ts";
import { getReservesSnapshot, type StoredSnapshot } from "./reserves.ts";

export interface LiabilityProof {
    snapshot: StoredSnapshot;
    root: SumNode;
    proof: SumProof;
}

/**
 * A user's proof that what they were owed is inside a snapshot's total.
 *
 * The tree is rebuilt from the snapshot's rows rather than stored: the rows
 * fix it completely. It is checked against the root recorded when the
 * snapshot was taken, so rows altered since then fail loudly here instead of
 * handing out proofs for a root nobody published.
 */
export async function proveLiability(pool: Pool, snapshotId: bigint, accountId: bigint): Promise<LiabilityProof> {
    const snapshot = await getReservesSnapshot(pool, snapshotId);
    if (snapshot === null) throw new ReservesSnapshotNotFound(snapshotId);
    if (snapshot.rootHash === null) throw new NoTreeForSnapshot(snapshotId);

    const { rows } = await pool.query<{ account_id: bigint; amount: string; salt: string }>(
        "SELECT account_id, amount, salt FROM reserve_liabilities WHERE snapshot_id = $1",
        [snapshotId],
    );
    const tree = buildSumTree(
        rows.map((row) => ({ salt: row.salt as Hex, accountId: row.account_id, amount: BigInt(row.amount) })),
    );
    if (tree.root.hash !== snapshot.rootHash || tree.root.sum !== snapshot.liabilities) {
        throw new Error(`snapshot ${snapshotId} no longer rebuilds to its recorded root`);
    }

    const proof = proveLeaf(tree, accountId);
    if (proof === undefined) throw new NotInSnapshot(snapshotId, accountId);
    return { snapshot, root: tree.root, proof };
}
