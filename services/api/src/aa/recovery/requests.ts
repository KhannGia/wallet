import { getAddress, parseSignature, recoverAddress, type Address, type Hex, type PublicClient } from "viem";

import { one, type Pool } from "../../db/pool.ts";
import { guardianModuleAbi, recoverableAccountAbi } from "./abi.ts";
import {
    DuplicateGuardianSignature,
    InvalidGuardianSignature,
    NotAGuardian,
    NotRecoverable,
    RecoveryDeadlineInPast,
    RecoveryExpired,
    RecoveryNotFound,
    RecoveryNotOpen,
} from "./errors.ts";
import { cancelDigest, recoveryDigest } from "./typed-data.ts";

/** Half the secp256k1 group order. The module, like the vault, rejects any s above it. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type RecoveryStatus =
    | "COLLECTING"
    | "STARTED"
    | "EXECUTED"
    | "CANCELLED"
    | "STALE"
    | "EXPIRED"
    | "LAPSED";

export interface RecoveryRequest {
    id: bigint;
    module: Address;
    chainId: number;
    account: Address;
    newOwner: Address;
    nonce: bigint;
    deadline: bigint;
    digest: Hex;
    threshold: number;
    status: RecoveryStatus;
    executableAt: bigint | null;
    startTx: Hex | null;
    executeTx: Hex | null;
    cancelDeadline: bigint | null;
    cancelDigest: Hex | null;
    failure: string | null;
}

interface RecoveryRow {
    id: bigint;
    module_address: string;
    chain_id: bigint;
    account_address: string;
    new_owner: string;
    nonce: string;
    deadline: bigint;
    digest: string;
    threshold: number;
    status: RecoveryStatus;
    executable_at: bigint | null;
    start_tx: string | null;
    execute_tx: string | null;
    cancel_deadline: bigint | null;
    cancel_digest: string | null;
    failure: string | null;
}

export function toRecoveryRequest(row: RecoveryRow): RecoveryRequest {
    return {
        id: row.id,
        module: row.module_address as Address,
        chainId: Number(row.chain_id),
        account: row.account_address as Address,
        newOwner: row.new_owner as Address,
        nonce: BigInt(row.nonce),
        deadline: row.deadline,
        digest: row.digest as Hex,
        threshold: row.threshold,
        status: row.status,
        executableAt: row.executable_at,
        startTx: row.start_tx as Hex | null,
        executeTx: row.execute_tx as Hex | null,
        cancelDeadline: row.cancel_deadline,
        cancelDigest: row.cancel_digest as Hex | null,
        failure: row.failure,
    };
}

export async function loadRecoveryRequest(pool: Pool, id: bigint): Promise<RecoveryRequest> {
    const { rows } = await pool.query<RecoveryRow>("SELECT * FROM recovery_requests WHERE id = $1", [id]);
    const row = rows[0];
    if (row === undefined) throw new RecoveryNotFound(id);
    return toRecoveryRequest(row);
}

/** Chain time: the module compares deadlines against block.timestamp. */
export async function chainNow(client: PublicClient): Promise<bigint> {
    return (await client.getBlock()).timestamp;
}

/**
 * Opens a request to hand `account` to `newOwner`, for the account's
 * guardians to approve.
 *
 * Anyone may open one -- the guardians' signatures are what authorise it -- and
 * several may be open for one account at once, so a stranger cannot block a
 * genuine recovery by opening a bogus one first.
 */
export async function createRecoveryRequest(
    deps: { pool: Pool; client: PublicClient },
    params: { module: Address; account: Address; newOwner: Address; deadline: bigint },
): Promise<RecoveryRequest> {
    const { pool, client } = deps;
    const { module, account } = params;

    const recoveryModule = await client
        .readContract({ address: account, abi: recoverableAccountAbi, functionName: "recoveryModule" })
        .catch(() => undefined);
    if (recoveryModule === undefined) throw new NotRecoverable(account, "it is not a smart account");
    if (recoveryModule.toLowerCase() !== module.toLowerCase()) {
        throw new NotRecoverable(account, "it has not chosen this guardian module");
    }

    const [chainId, nonce, threshold, now] = await Promise.all([
        client.getChainId(),
        client.readContract({ address: module, abi: guardianModuleAbi, functionName: "nonce", args: [account] }),
        client.readContract({ address: module, abi: guardianModuleAbi, functionName: "threshold", args: [account] }),
        chainNow(client),
    ]);
    if (threshold === 0n) throw new NotRecoverable(account, "it has no guardians");
    if (params.deadline <= now) throw new RecoveryDeadlineInPast(params.deadline, now);

    const digest = recoveryDigest(module, chainId, {
        account,
        newOwner: params.newOwner,
        nonce,
        deadline: params.deadline,
    });

    const { rows } = await pool.query<RecoveryRow>(
        `INSERT INTO recovery_requests
             (module_address, chain_id, account_address, new_owner, nonce, deadline, digest, threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [module, chainId, account, params.newOwner, nonce.toString(), params.deadline, digest, Number(threshold)],
    );
    return toRecoveryRequest(one(rows, "recovery request"));
}

/**
 * Opens a guardians' cancellation of a recovery that has started: fixes the
 * deadline the guardians sign over, and the nonce -- the one the module moved
 * to when this recovery started, so the cancellation fits it and no other.
 */
export async function openCancellation(
    deps: { pool: Pool; client: PublicClient },
    id: bigint,
    deadline: bigint,
): Promise<RecoveryRequest> {
    const { pool, client } = deps;
    const request = await loadRecoveryRequest(pool, id);
    if (request.status !== "STARTED") throw new RecoveryNotOpen(id, request.status, "STARTED");
    if (request.cancelDigest !== null) return request;

    const now = await chainNow(client);
    if (deadline <= now) throw new RecoveryDeadlineInPast(deadline, now);

    const digest = cancelDigest(request.module, request.chainId, {
        account: request.account,
        nonce: request.nonce + 1n,
        deadline,
    });
    const { rows } = await pool.query<RecoveryRow>(
        `UPDATE recovery_requests SET cancel_deadline = $2, cancel_digest = $3
          WHERE id = $1 AND cancel_digest IS NULL
          RETURNING *`,
        [id, deadline, digest],
    );
    return rows[0] === undefined ? loadRecoveryRequest(pool, id) : toRecoveryRequest(rows[0]);
}

export interface SignatureReceipt {
    guardian: Address;
    collected: number;
    threshold: number;
}

/**
 * Accepts one guardian's approval -- or, with kind CANCEL, their vote to
 * withdraw a started recovery -- after checking everything the module would:
 * a 65-byte signature, s in the lower half, and a signer who is a guardian of
 * this account right now.
 */
export async function addRecoverySignature(
    deps: { pool: Pool; client: PublicClient },
    id: bigint,
    kind: "APPROVE" | "CANCEL",
    signature: Hex,
): Promise<SignatureReceipt> {
    const { pool, client } = deps;
    const request = await loadRecoveryRequest(pool, id);

    let digest: Hex;
    let deadline: bigint;
    if (kind === "APPROVE") {
        if (request.status !== "COLLECTING") throw new RecoveryNotOpen(id, request.status, "COLLECTING");
        digest = request.digest;
        deadline = request.deadline;
    } else {
        if (request.status !== "STARTED" || request.cancelDigest === null || request.cancelDeadline === null) {
            throw new RecoveryNotOpen(id, request.status, "STARTED with a cancellation open");
        }
        digest = request.cancelDigest;
        deadline = request.cancelDeadline;
    }

    if ((await chainNow(client)) > deadline) {
        if (kind === "APPROVE") {
            await pool.query(
                "UPDATE recovery_requests SET status = 'EXPIRED', settled_at = now() WHERE id = $1 AND status = 'COLLECTING'",
                [id],
            );
        }
        throw new RecoveryExpired(id);
    }

    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new InvalidGuardianSignature("signature must be 65 bytes: r, s and v");
    }
    if (BigInt(parseSignature(signature).s) > HALF_N) {
        throw new InvalidGuardianSignature("signature is malleable: s is in the upper half of the curve order");
    }

    const guardian = await recoverAddress({ hash: digest, signature });
    const isGuardian = await client.readContract({
        address: request.module,
        abi: guardianModuleAbi,
        functionName: "isGuardian",
        args: [request.account, guardian],
    });
    if (!isGuardian) throw new NotAGuardian(guardian);

    try {
        await pool.query(
            "INSERT INTO recovery_signatures (request_id, kind, guardian, signature) VALUES ($1, $2, $3, $4)",
            [id, kind, guardian.toLowerCase(), signature],
        );
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
            throw new DuplicateGuardianSignature(guardian);
        }
        throw error;
    }

    const { rows } = await pool.query<{ collected: bigint }>(
        "SELECT COUNT(*) AS collected FROM recovery_signatures WHERE request_id = $1 AND kind = $2",
        [id, kind],
    );
    return {
        guardian,
        collected: Number(one(rows, "signature count").collected),
        threshold: request.threshold,
    };
}

export interface RecoveryDetail extends RecoveryRequest {
    approvals: Address[];
    cancellations: Address[];
}

export async function getRecoveryRequest(pool: Pool, id: bigint): Promise<RecoveryDetail> {
    const request = await loadRecoveryRequest(pool, id);
    const { rows } = await pool.query<{ kind: "APPROVE" | "CANCEL"; guardian: string }>(
        "SELECT kind, guardian FROM recovery_signatures WHERE request_id = $1 ORDER BY created_at, guardian",
        [id],
    );
    return {
        ...request,
        approvals: rows.filter((r) => r.kind === "APPROVE").map((r) => getAddress(r.guardian)),
        cancellations: rows.filter((r) => r.kind === "CANCEL").map((r) => getAddress(r.guardian)),
    };
}
