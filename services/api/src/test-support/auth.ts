import { createHash, randomBytes } from "node:crypto";

import type { Pool } from "../db/pool.ts";

/** The admin token tests configure. Not a secret: it exists only in tests. */
export const TEST_ADMIN_TOKEN = "test-admin-token-not-a-secret-0123456789";

export const adminHeaders = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

/**
 * A session for the owner of `accountId`, written straight to the table. A
 * fixture: real sign-ins go through the password check, which the auth tests
 * cover; everything else only needs to be signed in.
 */
export async function sessionFor(pool: Pool, accountId: bigint | string): Promise<{ authorization: string }> {
    const token = randomBytes(32).toString("base64url");
    const { rowCount } = await pool.query(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         SELECT user_id, $2, now() + interval '1 hour' FROM accounts WHERE id = $1 AND user_id IS NOT NULL`,
        [accountId, createHash("sha256").update(token).digest("hex")],
    );
    if (rowCount !== 1) throw new Error(`account ${accountId} has no user to sign in as`);
    return { authorization: `Bearer ${token}` };
}
