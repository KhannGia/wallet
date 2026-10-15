import type { FastifyInstance } from "fastify";

import type { Pool } from "../db/pool.ts";
import { requireUser, revokeSession, signIn } from "../auth/sessions.ts";
import type { AuthConfig } from "./ledger.ts";
import { signInSchema } from "./schemas.ts";

export function registerAuthRoutes(app: FastifyInstance, pool: Pool, auth: AuthConfig): void {
    app.post("/api/v1/sessions", async (request, reply) => {
        const { email, password } = signInSchema.parse(request.body);
        const session = await signIn(pool, { email, password, ttlSeconds: auth.sessionTtlSeconds });
        return reply.code(201).send({
            userId: session.userId.toString(),
            token: session.token,
            expiresAt: session.expiresAt.toISOString(),
        });
    });

    // Signing out ends this session only; others the user holds stay open.
    app.delete("/api/v1/sessions/current", async (request, reply) => {
        await revokeSession(pool, request);
        return reply.code(204).send();
    });

    app.get("/api/v1/me", async (request) => {
        const userId = await requireUser(pool, request);
        const { rows } = await pool.query<{ email: string; account_id: bigint; deposit_address: string | null }>(
            `SELECT u.email, a.id AS account_id, a.deposit_address
               FROM users u JOIN accounts a ON a.user_id = u.id
              WHERE u.id = $1 ORDER BY a.id`,
            [userId],
        );
        return {
            userId: userId.toString(),
            email: rows[0]?.email ?? null,
            accounts: rows.map((row) => ({ accountId: row.account_id.toString(), depositAddress: row.deposit_address })),
        };
    });
}
