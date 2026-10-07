import { parseEventLogs, type Hex, type PublicClient, type WalletClient } from "viem";

import { withTransaction, type Pool, type PoolClient } from "../../db/pool.ts";
import { guardianModuleAbi, recoverableAccountAbi } from "./abi.ts";
import { chainNow, toRecoveryRequest, type RecoveryRequest } from "./requests.ts";

export type RelayOutcome =
    | { kind: "started"; executableAt: bigint; transactionHash: Hex }
    | { kind: "executed"; transactionHash: Hex | null }
    // "elsewhere": gone from the module without this relayer cancelling it --
    // the owner's veto, or guardians submitting their cancellation themselves.
    | { kind: "cancelled"; by: "guardians" | "elsewhere" }
    | { kind: "waiting"; executableAt: bigint }
    | { kind: "stale" | "expired" | "lapsed" }
    | { kind: "reverted"; reason: string };

export interface RelayReport {
    id: bigint;
    outcome: RelayOutcome;
}

type Deps = { pool: Pool; client: PublicClient; wallet: WalletClient };

function firstLine(error: unknown): string {
    return error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
}

async function settle(tx: PoolClient, id: bigint, status: string, extra = "", values: unknown[] = []) {
    await tx.query(
        `UPDATE recovery_requests SET status = '${status}', settled_at = now()${extra} WHERE id = $1`,
        [id, ...values],
    );
}

async function recordFailure(tx: PoolClient, id: bigint, reason: string) {
    await tx.query("UPDATE recovery_requests SET failure = $2 WHERE id = $1", [id, reason]);
}

async function signaturesFor(tx: PoolClient, request: RecoveryRequest, kind: "APPROVE" | "CANCEL") {
    // Lower-case hex addresses of equal length sort as the numbers they encode:
    // the module's strictly ascending order.
    const { rows } = await tx.query<{ signature: string }>(
        `SELECT signature FROM recovery_signatures
          WHERE request_id = $1 AND kind = $2 ORDER BY guardian LIMIT $3`,
        [request.id, kind, request.threshold],
    );
    return rows.map((row) => row.signature as Hex);
}

async function send(
    deps: Deps,
    request: RecoveryRequest,
    call:
        | { functionName: "initiateRecovery"; args: readonly [Hex, Hex, bigint, readonly Hex[]] }
        | { functionName: "executeRecovery"; args: readonly [Hex] }
        | { functionName: "cancelRecoveryWithGuardians"; args: readonly [Hex, bigint, readonly Hex[]] },
) {
    const account = deps.wallet.account;
    if (account === undefined) throw new Error("recovery relayer has no signing account");
    const hash = await deps.wallet.writeContract({
        account,
        chain: null,
        address: request.module,
        abi: guardianModuleAbi,
        ...call,
    } as Parameters<WalletClient["writeContract"]>[0]);
    const receipt = await deps.client.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: guardianModuleAbi, logs: receipt.logs }).filter(
        (log) =>
            log.address.toLowerCase() === request.module.toLowerCase() &&
            log.args.account.toLowerCase() === request.account.toLowerCase(),
    );
    return { hash, receipt, logs };
}

/**
 * Submits a request that has its quorum of approvals.
 *
 * As with the vault, a moved nonce is first checked against the module's own
 * record: the recovery may be this very request, started by an earlier pass
 * that lost its receipt, rather than another one that got there first.
 */
async function start(deps: Deps, id: bigint): Promise<RelayOutcome> {
    const { client } = deps;
    return withTransaction(deps.pool, async (tx): Promise<RelayOutcome> => {
        const { rows } = await tx.query("SELECT * FROM recovery_requests WHERE id = $1 FOR UPDATE", [id]);
        const request = toRecoveryRequest(rows[0]);
        if (request.status !== "COLLECTING") return { kind: "stale" };

        const [nonce, [pendingOwner, pendingAt], now] = await Promise.all([
            client.readContract({ address: request.module, abi: guardianModuleAbi, functionName: "nonce", args: [request.account] }),
            client.readContract({ address: request.module, abi: guardianModuleAbi, functionName: "pending", args: [request.account] }),
            chainNow(client),
        ]);

        if (nonce !== request.nonce) {
            if (pendingAt !== 0n && pendingOwner.toLowerCase() === request.newOwner.toLowerCase()) {
                const started = await client.getContractEvents({
                    address: request.module,
                    abi: guardianModuleAbi,
                    eventName: "RecoveryStarted",
                    args: { account: request.account, newOwner: request.newOwner },
                    fromBlock: "earliest",
                });
                const hash = started.at(-1)?.transactionHash ?? null;
                await tx.query(
                    "UPDATE recovery_requests SET status = 'STARTED', executable_at = $2, start_tx = $3, failure = NULL WHERE id = $1",
                    [id, pendingAt, hash],
                );
                return { kind: "started", executableAt: pendingAt, transactionHash: hash as Hex };
            }
            await settle(tx, id, "STALE");
            return { kind: "stale" };
        }
        if (now > request.deadline) {
            await settle(tx, id, "EXPIRED");
            return { kind: "expired" };
        }

        const signatures = await signaturesFor(tx, request, "APPROVE");
        let sent;
        try {
            sent = await send(deps, request, {
                functionName: "initiateRecovery",
                args: [request.account, request.newOwner, request.deadline, signatures],
            });
        } catch (error) {
            const reason = firstLine(error);
            await recordFailure(tx, id, reason);
            return { kind: "reverted", reason };
        }

        const startedLog = sent.logs.find((log) => log.eventName === "RecoveryStarted");
        if (sent.receipt.status !== "success" || startedLog === undefined || !("executableAt" in startedLog.args)) {
            const reason = `transaction ${sent.hash} did not start the recovery`;
            await recordFailure(tx, id, reason);
            return { kind: "reverted", reason };
        }
        const executableAt = startedLog.args.executableAt;
        await tx.query(
            "UPDATE recovery_requests SET status = 'STARTED', executable_at = $2, start_tx = $3, failure = NULL WHERE id = $1",
            [id, executableAt, sent.hash],
        );
        return { kind: "started", executableAt, transactionHash: sent.hash };
    });
}

/**
 * Moves a started recovery along: records it if the owner vetoed it or it
 * already ran, relays a guardian cancellation once it has its quorum, waits
 * out the delay, and executes it once it matures -- unless it has lapsed.
 *
 * A guardians' cancellation is checked before execution: withdrawing a
 * recovery must still work after it matures, until somebody executes it.
 */
async function advance(deps: Deps, id: bigint): Promise<RelayOutcome> {
    const { client } = deps;
    return withTransaction(deps.pool, async (tx): Promise<RelayOutcome> => {
        const { rows } = await tx.query("SELECT * FROM recovery_requests WHERE id = $1 FOR UPDATE", [id]);
        const request = toRecoveryRequest(rows[0]);
        if (request.status !== "STARTED" || request.executableAt === null) return { kind: "stale" };

        const [[pendingOwner, pendingAt], owner, window, now] = await Promise.all([
            client.readContract({ address: request.module, abi: guardianModuleAbi, functionName: "pending", args: [request.account] }),
            client.readContract({ address: request.account, abi: recoverableAccountAbi, functionName: "owner" }),
            client.readContract({ address: request.module, abi: guardianModuleAbi, functionName: "EXECUTION_WINDOW" }),
            chainNow(client),
        ]);

        const stillPending =
            pendingAt === request.executableAt && pendingOwner.toLowerCase() === request.newOwner.toLowerCase();
        if (!stillPending) {
            // Gone from the module: executed (a receipt lost), or cancelled.
            if (owner.toLowerCase() === request.newOwner.toLowerCase()) {
                const executed = await client.getContractEvents({
                    address: request.module,
                    abi: guardianModuleAbi,
                    eventName: "RecoveryExecuted",
                    args: { account: request.account, newOwner: request.newOwner },
                    fromBlock: "earliest",
                });
                const hash = executed.at(-1)?.transactionHash ?? null;
                await settle(tx, id, "EXECUTED", ", execute_tx = $2", [hash]);
                return { kind: "executed", transactionHash: hash };
            }
            await settle(tx, id, "CANCELLED");
            return { kind: "cancelled", by: "elsewhere" };
        }

        if (request.cancelDeadline !== null && now <= request.cancelDeadline) {
            const cancellations = await signaturesFor(tx, request, "CANCEL");
            if (cancellations.length >= request.threshold) {
                try {
                    const sent = await send(deps, request, {
                        functionName: "cancelRecoveryWithGuardians",
                        args: [request.account, request.cancelDeadline, cancellations],
                    });
                    if (sent.receipt.status === "success" && sent.logs.some((l) => l.eventName === "RecoveryCancelled")) {
                        await settle(tx, id, "CANCELLED");
                        return { kind: "cancelled", by: "guardians" };
                    }
                } catch (error) {
                    const reason = firstLine(error);
                    await recordFailure(tx, id, reason);
                    return { kind: "reverted", reason };
                }
            }
        }

        if (now < request.executableAt) return { kind: "waiting", executableAt: request.executableAt };
        if (now > request.executableAt + window) {
            await settle(tx, id, "LAPSED");
            return { kind: "lapsed" };
        }

        let sent;
        try {
            sent = await send(deps, request, { functionName: "executeRecovery", args: [request.account] });
        } catch (error) {
            const reason = firstLine(error);
            await recordFailure(tx, id, reason);
            return { kind: "reverted", reason };
        }
        if (sent.receipt.status !== "success" || !sent.logs.some((l) => l.eventName === "RecoveryExecuted")) {
            const reason = `transaction ${sent.hash} did not execute the recovery`;
            await recordFailure(tx, id, reason);
            return { kind: "reverted", reason };
        }
        await settle(tx, id, "EXECUTED", ", execute_tx = $2", [sent.hash]);
        return { kind: "executed", transactionHash: sent.hash };
    });
}

/**
 * One pass: starts every request that has its quorum, then moves every started
 * one along. Requests with a recorded failure wait for a retry, as vault
 * proposals do, rather than spending gas on the same revert every pass.
 */
export async function runRecoveryRelayOnce(deps: Deps): Promise<RelayReport[]> {
    const reports: RelayReport[] = [];

    const { rows: ready } = await deps.pool.query<{ id: bigint }>(
        `SELECT r.id FROM recovery_requests r
          WHERE r.status = 'COLLECTING' AND r.failure IS NULL
            AND (SELECT COUNT(*) FROM recovery_signatures s
                  WHERE s.request_id = r.id AND s.kind = 'APPROVE') >= r.threshold
          ORDER BY r.id`,
    );
    for (const { id } of ready) reports.push({ id, outcome: await start(deps, id) });

    const { rows: started } = await deps.pool.query<{ id: bigint }>(
        "SELECT id FROM recovery_requests WHERE status = 'STARTED' AND failure IS NULL ORDER BY id",
    );
    for (const { id } of started) reports.push({ id, outcome: await advance(deps, id) });

    return reports;
}

/** Clears a recorded failure so the relayer tries the request again. */
export async function retryRecovery(pool: Pool, id: bigint): Promise<void> {
    await pool.query(
        "UPDATE recovery_requests SET failure = NULL WHERE id = $1 AND status IN ('COLLECTING', 'STARTED')",
        [id],
    );
}
