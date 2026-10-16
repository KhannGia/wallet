import { EMPTY_NODE, reservesRegistryAbi } from "@wallet/shared";
import { parseEventLogs, type Address, type Hash, type PublicClient, type WalletClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { takeReservesSnapshot, type ReservesConfig } from "./reserves.ts";

export { reservesRegistryAbi };

export interface PublisherDeps {
    pool: Pool;
    client: PublicClient;
    /** Signs as the registry's publisher. Absent, snapshots are taken but not published. */
    wallet?: WalletClient;
}

export interface PublisherConfig extends ReservesConfig {
    registry?: Address;
}

export type Publication =
    | { kind: "published"; attestationId: bigint; transactionHash: Hash }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; reason: string };

export interface ReservesRun {
    snapshotId: bigint;
    solvent: boolean;
    surplus: bigint;
    publication: Publication;
    /** Earlier snapshots found published after all -- a receipt lost to a crash. */
    recovered: number;
}

/**
 * Snapshots whose root reached the registry though the row never heard: the
 * transaction went out and the process stopped before recording it. Looked up
 * by root, which identifies a snapshot -- except the empty tree's, which every
 * snapshot of a platform with no users shares.
 */
async function recoverLostPublications(deps: PublisherDeps, registry: Address): Promise<number> {
    const { rows } = await deps.pool.query<{ id: bigint; root_hash: string }>(
        `SELECT id, root_hash FROM reserve_snapshots
          WHERE attestation_id IS NULL AND root_hash IS NOT NULL AND root_hash <> $1
          ORDER BY id DESC LIMIT 20`,
        [EMPTY_NODE.hash],
    );
    let recovered = 0;
    for (const row of rows) {
        const found = await deps.client
            .readContract({ address: registry, abi: reservesRegistryAbi, functionName: "findByRoot", args: [row.root_hash as Hash] })
            .catch(() => undefined);
        if (found === undefined) continue;
        await deps.pool.query(
            `UPDATE reserve_snapshots
                SET registry_address = $2, attestation_id = $3, published_at = now(), publish_failure = NULL
              WHERE id = $1 AND attestation_id IS NULL`,
            [row.id, registry, found[0]],
        );
        recovered += 1;
    }
    return recovered;
}

async function publish(
    deps: PublisherDeps,
    registry: Address,
    snapshot: { id: bigint; root: Hash; liabilities: bigint; assets: bigint; blockNumber: bigint },
): Promise<Publication> {
    const wallet = deps.wallet;
    const account = wallet?.account;
    if (wallet === undefined || account === undefined) return { kind: "skipped", reason: "no publisher key" };

    // The registry only moves forwards. A cursor rewound by a reorg can make
    // this snapshot's block older than the last one published; it waits for a
    // later snapshot rather than failing on chain.
    const count = await deps.client.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "count" });
    if (count > 0n) {
        const [, last] = await deps.client.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "latest" });
        if (snapshot.blockNumber < last.blockNumber) {
            return { kind: "skipped", reason: `block ${snapshot.blockNumber} is before the last published, ${last.blockNumber}` };
        }
    }

    const hash = await wallet.writeContract({
        address: registry,
        abi: reservesRegistryAbi,
        functionName: "publish",
        args: [snapshot.root, snapshot.liabilities, snapshot.assets, snapshot.blockNumber],
        account,
        chain: null,
    });
    const receipt = await deps.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { kind: "failed", reason: `publish transaction ${hash} reverted` };
    const [event] = parseEventLogs({ abi: reservesRegistryAbi, logs: receipt.logs, eventName: "Published" });
    if (event === undefined) return { kind: "failed", reason: `publish transaction ${hash} emitted no Published event` };
    return { kind: "published", attestationId: event.args.id, transactionHash: hash };
}

/**
 * One pass of the reserves worker: snapshot, then publish the root.
 *
 * A shortfall is published like any other snapshot -- the point of publishing
 * is that the platform cannot choose which ones the world sees. A failed
 * publication is recorded on the snapshot and does not stop the next pass.
 */
export async function runReservesOnce(deps: PublisherDeps, config: PublisherConfig): Promise<ReservesRun> {
    const recovered = config.registry === undefined ? 0 : await recoverLostPublications(deps, config.registry);
    const snapshot = await takeReservesSnapshot(deps, config);

    let publication: Publication;
    if (config.registry === undefined) {
        publication = { kind: "skipped", reason: "no registry configured" };
    } else {
        try {
            publication = await publish(deps, config.registry, {
                id: snapshot.id,
                root: snapshot.root.hash,
                liabilities: snapshot.report.liabilities.total,
                assets: snapshot.report.assets.total,
                blockNumber: snapshot.report.blockNumber,
            });
        } catch (error) {
            publication = { kind: "failed", reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
        }
    }

    if (publication.kind === "published") {
        await deps.pool.query(
            `UPDATE reserve_snapshots
                SET registry_address = $2, attestation_id = $3, publish_tx = $4, published_at = now()
              WHERE id = $1`,
            [snapshot.id, config.registry, publication.attestationId, publication.transactionHash],
        );
    } else {
        await deps.pool.query("UPDATE reserve_snapshots SET publish_failure = $2 WHERE id = $1", [
            snapshot.id,
            publication.reason,
        ]);
    }

    return {
        snapshotId: snapshot.id,
        solvent: snapshot.report.solvent,
        surplus: snapshot.report.surplus,
        publication,
        recovered,
    };
}
