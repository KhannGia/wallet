import {
    encodeFunctionData,
    getAddress,
    hexToBigInt,
    pad,
    size,
    slice,
    toHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { BundlerClient, PaymasterClient } from "viem/account-abstraction";

import type { Pool } from "../../db/pool.ts";
import { smartAccountAbi, toSessionAccount } from "../smart-account.ts";
import { openKey, sealKey, sessionAad } from "./crypto.ts";

/** A refusal the caller can act on, with an HTTP status for the server to use. */
export class SessionError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = "SessionError";
        this.code = code;
        this.status = status;
    }
}

const OPERATORS = { eq: 0, lte: 1, gte: 2 } as const;

export interface ConditionInput {
    param: number;
    operator: keyof typeof OPERATORS;
    /** A number (decimal string), an address, or up to 32 bytes of hex. */
    value: string;
}

export interface SessionRequest {
    account: Address;
    validForSeconds: number;
    nativeLimit: bigint;
    permissions: { target: Address; selector: Hex; conditions: ConditionInput[] }[];
    limits: { token: Address; limit: bigint }[];
}

function toWord(value: string): Hex {
    if (/^[0-9]+$/.test(value)) return pad(toHex(BigInt(value)), { size: 32 });
    if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) return pad(value as Hex, { size: 32 });
    throw new SessionError("invalid_condition", 400, `condition value ${value} is not a number, address or word`);
}

interface SessionRow {
    id: bigint;
    account_address: string;
    key_address: string;
    ciphertext: Buffer | null;
    iv: Buffer | null;
    auth_tag: Buffer | null;
    key_version: number;
    permissions: SessionRequest["permissions"] & { limits?: unknown };
    valid_after: bigint;
    valid_until: bigint;
    status: "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";
}

export interface SessionManagerConfig {
    masterKey: Buffer;
    keyVersion: number;
    factory: Address;
}

/**
 * Holds session keys for apps and bots, and spends with them on request.
 *
 * The keys never leave this process in the clear: created here, sealed before
 * they reach the database, opened only to sign, and shredded -- the ciphertext
 * deleted -- when a session ends. No endpoint returns one.
 *
 * Granting a session is the owner's act, on chain, from their own wallet: this
 * service only proposes it, returning the addSession call for them to send.
 * Revoking has two halves for the same reason: shredding here stops this
 * service; only the owner's revokeSession on chain stops everyone.
 */
export function createSessionManager(
    deps: {
        pool: Pool;
        client: PublicClient;
        bundler: BundlerClient;
        /** Sponsors gas when an operation asks for it. Optional. */
        paymaster?: PaymasterClient;
    },
    config: SessionManagerConfig,
) {
    const { pool, client, bundler } = deps;

    async function load(id: bigint): Promise<SessionRow> {
        const { rows } = await pool.query<SessionRow>("SELECT * FROM session_keys WHERE id = $1", [id]);
        const row = rows[0];
        if (row === undefined) throw new SessionError("session_not_found", 404, `session ${id} does not exist`);
        return row;
    }

    /** Ends a session here: the ciphertext is deleted, not merely flagged. */
    async function shred(id: bigint, status: "REVOKED" | "EXPIRED"): Promise<void> {
        await pool.query(
            `UPDATE session_keys
                SET status = $2, ciphertext = NULL, iv = NULL, auth_tag = NULL, ended_at = now()
              WHERE id = $1 AND status IN ('PENDING', 'ACTIVE')`,
            [id, status],
        );
    }

    function grantCall(row: { key_address: string; valid_after: bigint; valid_until: bigint }, request: SessionRequest): Hex {
        return encodeFunctionData({
            abi: smartAccountAbi,
            functionName: "addSession",
            args: [
                getAddress(row.key_address),
                Number(row.valid_after),
                Number(row.valid_until),
                request.nativeLimit,
                request.permissions.map((p) => ({
                    target: p.target,
                    selector: p.selector,
                    conditions: p.conditions.map((c) => ({
                        param: c.param,
                        operator: OPERATORS[c.operator],
                        value: toWord(c.value),
                    })),
                })),
                request.limits.map((l) => ({ token: l.token, limit: l.limit })),
            ],
        });
    }

    return {
        /**
         * Creates a session key for `account` and returns what the owner must
         * send to grant it. The key itself is never returned.
         */
        async create(request: SessionRequest) {
            const code = await client.getCode({ address: request.account });
            if (code === undefined || code === "0x") {
                throw new SessionError("not_a_smart_account", 409, `${request.account} has no account deployed`);
            }
            const now = (await client.getBlock()).timestamp;
            const validUntil = now + BigInt(request.validForSeconds);

            const privateKey = generatePrivateKey();
            const key = privateKeyToAccount(privateKey);
            const sealed = sealKey(config.masterKey, privateKey, sessionAad(request.account, key.address));

            // Fails here, before anything is stored, if a condition is malformed.
            const draft = { key_address: key.address, valid_after: 0n, valid_until: validUntil };
            const callData = grantCall(draft, request);

            const { rows } = await pool.query<{ id: bigint }>(
                `INSERT INTO session_keys
                     (account_address, key_address, ciphertext, iv, auth_tag, key_version,
                      permissions, valid_after, valid_until)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)
                 RETURNING id`,
                [
                    request.account.toLowerCase(),
                    key.address.toLowerCase(),
                    sealed.ciphertext,
                    sealed.iv,
                    sealed.tag,
                    config.keyVersion,
                    JSON.stringify({
                        permissions: request.permissions,
                        limits: request.limits.map((l) => ({ token: l.token, limit: l.limit.toString() })),
                        nativeLimit: request.nativeLimit.toString(),
                    }),
                    validUntil,
                ],
            );

            return {
                id: rows[0]!.id,
                sessionKey: key.address,
                validUntil,
                // The owner sends this from their own wallet, as an operation on
                // the account: addSession is callable only by the account.
                grant: { to: request.account, data: callData },
            };
        },

        /**
         * Signs and sends one call with the session's key, after checking it
         * on chain: granted, not expired, and within what it may still spend.
         * The account enforces all of this anyway; checking first means an
         * over-limit call is refused here instead of reverting on chain at the
         * cost of gas.
         */
        async execute(id: bigint, call: { to: Address; value: bigint; data: Hex }, options: { sponsored: boolean }) {
            const row = await load(id);
            if (row.status !== "PENDING" && row.status !== "ACTIVE") {
                throw new SessionError("session_ended", 410, `session ${id} is ${row.status}`);
            }
            const account = getAddress(row.account_address);
            const keyAddress = getAddress(row.key_address);

            const now = (await client.getBlock()).timestamp;
            if (now >= row.valid_until) {
                await shred(id, "EXPIRED");
                throw new SessionError("session_ended", 410, `session ${id} expired`);
            }

            const [active, , , nativeLimit, nativeSpent] = await client.readContract({
                address: account,
                abi: smartAccountAbi,
                functionName: "sessions",
                args: [keyAddress],
            });
            if (!active) {
                if (row.status === "ACTIVE") {
                    // It was live and is not any more: the owner revoked it.
                    await shred(id, "REVOKED");
                    throw new SessionError("session_ended", 410, `session ${id} was revoked on chain`);
                }
                throw new SessionError("session_not_granted", 409, `session ${id} has not been granted yet`);
            }
            if (row.status === "PENDING") {
                await pool.query("UPDATE session_keys SET status = 'ACTIVE' WHERE id = $1 AND status = 'PENDING'", [id]);
            }

            if (nativeSpent + call.value > nativeLimit) {
                throw new SessionError("over_limit", 422, `would spend ${nativeSpent + call.value} wei of ${nativeLimit}`);
            }
            const selector = size(call.data) >= 4 ? slice(call.data, 0, 4) : "0x";
            if (selector === "0xa9059cbb" || selector === "0x095ea7b3") {
                const [capped, limit, spent] = await client.readContract({
                    address: account,
                    abi: smartAccountAbi,
                    functionName: "tokenAllowances",
                    args: [keyAddress, call.to],
                });
                const amount = size(call.data) >= 68 ? hexToBigInt(slice(call.data, 36, 68)) : 0n;
                if (capped && spent + amount > limit) {
                    throw new SessionError("over_limit", 422, `would spend ${spent + amount} of ${limit}`);
                }
            }

            if (row.ciphertext === null || row.iv === null || row.auth_tag === null) {
                throw new SessionError("session_ended", 410, `session ${id} has no key`);
            }
            const sessionKey = privateKeyToAccount(
                openKey(
                    config.masterKey,
                    { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag },
                    sessionAad(account, keyAddress),
                ),
            );
            const sessionAccount = await toSessionAccount({
                client,
                sessionKey,
                account,
                factory: config.factory,
            });

            if (options.sponsored && deps.paymaster === undefined) {
                throw new SessionError("no_sponsor", 409, "no paymaster is configured to sponsor this");
            }
            const hash = await bundler.sendUserOperation({
                account: sessionAccount,
                calls: [call],
                ...(options.sponsored ? { paymaster: deps.paymaster } : {}),
            });
            const receipt = await bundler.waitForUserOperationReceipt({ hash });
            return {
                userOpHash: hash,
                success: receipt.success,
                transactionHash: receipt.receipt.transactionHash,
            };
        },

        /**
         * Ends the session here, at once, and returns the call that ends it on
         * chain. Until the owner sends that, the key is still valid on the
         * account -- but nobody holds it any more, this service included.
         */
        async revoke(id: bigint) {
            const row = await load(id);
            await shred(id, "REVOKED");
            return {
                revoke: {
                    to: getAddress(row.account_address),
                    data: encodeFunctionData({
                        abi: smartAccountAbi,
                        functionName: "revokeSession",
                        args: [getAddress(row.key_address)],
                    }),
                },
            };
        },

        async get(id: bigint) {
            const row = await load(id);
            return {
                id: row.id.toString(),
                account: getAddress(row.account_address),
                sessionKey: getAddress(row.key_address),
                status: row.status,
                validUntil: row.valid_until.toString(),
                permissions: row.permissions,
            };
        },

        /** Shreds every session past its validity. Run on a timer. */
        async purgeExpired(): Promise<number> {
            const now = (await client.getBlock()).timestamp;
            const { rowCount } = await pool.query(
                `UPDATE session_keys
                    SET status = 'EXPIRED', ciphertext = NULL, iv = NULL, auth_tag = NULL, ended_at = now()
                  WHERE status IN ('PENDING', 'ACTIVE') AND valid_until <= $1`,
                [now],
            );
            return rowCount ?? 0;
        },
    };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
