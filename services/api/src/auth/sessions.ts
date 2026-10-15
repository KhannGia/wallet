import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { Pool } from "../db/pool.ts";
import { AccountNotFound } from "../ledger/errors.ts";
import { AdminNotConfigured, InvalidCredentials, NotAdmin, NotSignedIn } from "./errors.ts";
import { DUMMY_HASH, verifyPassword } from "./passwords.ts";

/**
 * Sessions: a random token handed to the user at sign-in, presented as a
 * bearer token on every request, and stored only as its SHA-256.
 *
 * A plain hash is enough here, unlike for passwords: the token is 32 random
 * bytes, so there is nothing to guess -- the hash only has to stop a leaked
 * table from being replayed as sessions.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface Session {
    token: string;
    userId: bigint;
    expiresAt: Date;
}

export async function createSession(pool: Pool, userId: bigint, ttlSeconds: number): Promise<Session> {
    const token = randomBytes(32).toString("base64url");
    const { rows } = await pool.query<{ expires_at: Date }>(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING expires_at`,
        [userId, sha256(token), ttlSeconds],
    );
    return { token, userId, expiresAt: rows[0]!.expires_at };
}

/** Checks an email and password and opens a session. */
export async function signIn(
    pool: Pool,
    params: { email: string; password: string; ttlSeconds: number },
): Promise<Session> {
    const { rows } = await pool.query<{ id: bigint; password_hash: string | null }>(
        "SELECT id, password_hash FROM users WHERE lower(email) = lower($1)",
        [params.email],
    );
    const user = rows[0];
    // Hashed either way, so an unknown email costs the same time as a wrong password.
    const valid = await verifyPassword(params.password, user?.password_hash ?? DUMMY_HASH);
    if (user === undefined || user.password_hash === null || !valid) throw new InvalidCredentials();
    return createSession(pool, user.id, params.ttlSeconds);
}

function bearer(request: FastifyRequest): string | undefined {
    const header = request.headers.authorization;
    if (typeof header !== "string") return undefined;
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1];
}

/** The signed-in user, or a 401. */
export async function requireUser(pool: Pool, request: FastifyRequest): Promise<bigint> {
    const token = bearer(request);
    if (token === undefined) throw new NotSignedIn();
    const { rows } = await pool.query<{ user_id: bigint }>(
        `SELECT user_id FROM auth_sessions
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [sha256(token)],
    );
    const session = rows[0];
    if (session === undefined) throw new NotSignedIn();
    return session.user_id;
}

/**
 * The signed-in user, provided they own the account; otherwise a 404 -- not a
 * 403, which would confirm to a stranger that the account exists.
 */
export async function requireAccountOwner(pool: Pool, request: FastifyRequest, accountId: bigint): Promise<bigint> {
    const userId = await requireUser(pool, request);
    const { rows } = await pool.query("SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2 AND type = 'USER'", [
        accountId,
        userId,
    ]);
    if (rows.length === 0) throw new AccountNotFound(accountId);
    return userId;
}

export async function revokeSession(pool: Pool, request: FastifyRequest): Promise<void> {
    const token = bearer(request);
    if (token === undefined) throw new NotSignedIn();
    const { rowCount } = await pool.query(
        "UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [sha256(token)],
    );
    if (rowCount === 0) throw new NotSignedIn();
}

/**
 * The operator's token, for the admin endpoints. Compared in constant time on
 * hashes of equal length: timingSafeEqual needs equal lengths, and checking
 * the length first would leak it.
 */
export function requireAdmin(request: FastifyRequest, adminToken: string | undefined): void {
    if (adminToken === undefined) throw new AdminNotConfigured();
    const presented = bearer(request);
    if (presented === undefined) throw new NotAdmin();
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(adminToken).digest();
    if (!timingSafeEqual(a, b)) throw new NotAdmin();
}
