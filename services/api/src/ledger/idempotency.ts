import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { one, withTransaction } from "../db/pool.ts";
import { IdempotencyKeyReused, RequestInFlight } from "./errors.ts";

export type TxKind = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER" | "REVERSAL";

export interface IdempotentOutcome<T> {
    /** True when this call returned the stored result of an earlier request. */
    replayed: boolean;
    transactionId: bigint;
    result: T;
}

/** Serialises with object keys sorted, so key order in the request body cannot change the hash. */
function canonicalise(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(typeof value === "bigint" ? value.toString() : value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalise).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

export function fingerprint(body: unknown): string {
    return createHash("sha256").update(canonicalise(body)).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

interface ExistingRow {
    id: bigint;
    status: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
    request_fingerprint: string;
    response: unknown;
}

/**
 * Runs `work` at most once per idempotency key.
 *
 * Correctness rests on the UNIQUE constraint on transactions.idempotency_key,
 * not on checking whether the key exists first -- that check would itself be
 * racy. Two simultaneous requests with the same key both attempt the INSERT;
 * the second blocks on the unique index until the first commits, then fails
 * with 23505 and replays the stored response.
 *
 * If `work` throws, the whole transaction rolls back and the key is released,
 * so a genuinely failed request can be retried with the same key.
 */
export async function runIdempotent<T>(
    pool: Pool,
    params: { key: string; kind: TxKind; body: unknown; metadata?: Record<string, unknown> },
    work: (client: PoolClient, transactionId: bigint) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
    const requestFingerprint = fingerprint(params.body);

    try {
        return await withTransaction(pool, async (client) => {
            const inserted = one(
                (
                    await client.query<{ id: bigint }>(
                        `INSERT INTO transactions
                             (idempotency_key, request_fingerprint, kind, metadata)
                         VALUES ($1, $2, $3, $4)
                         RETURNING id`,
                        [
                            params.key,
                            requestFingerprint,
                            params.kind,
                            JSON.stringify(params.metadata ?? {}),
                        ],
                    )
                ).rows,
                "transaction",
            );

            const result = await work(client, inserted.id);

            await client.query(
                `UPDATE transactions
                    SET status = 'COMPLETED', response = $1, completed_at = now()
                  WHERE id = $2`,
                [
                    JSON.stringify(result, (_key, value) =>
                        typeof value === "bigint" ? value.toString() : value,
                    ),
                    inserted.id,
                ],
            );

            return { replayed: false, transactionId: inserted.id, result };
        });
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }

        const existing = one(
            (
                await pool.query<ExistingRow>(
                    `SELECT id, status, request_fingerprint, response
                       FROM transactions WHERE idempotency_key = $1`,
                    [params.key],
                )
            ).rows,
            "existing transaction",
        );

        // Same key, different body: the client has a bug, and silently
        // returning the old result would hide it.
        if (existing.request_fingerprint !== requestFingerprint) {
            throw new IdempotencyKeyReused();
        }

        if (existing.status !== "COMPLETED") {
            throw new RequestInFlight();
        }

        // The stored response came back through JSONB, so it is already the
        // shape the first call returned.
        return {
            replayed: true,
            transactionId: existing.id,
            result: existing.response as T,
        };
    }
}
