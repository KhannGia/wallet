import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { EmailTaken } from "../auth/errors.ts";
import { hashPassword } from "../auth/passwords.ts";
import { createSession, requireAccountOwner, requireAdmin } from "../auth/sessions.ts";
import { MissingIdempotencyKey, PayoutsNotConfigured } from "../ledger/errors.ts";
import { createUser, getAccount, listEntries, reconcile, transfer } from "../ledger/operations.ts";
import { requestWithdrawal } from "../ledger/withdrawals.ts";
import {
    accountIdSchema,
    createUserSchema,
    entriesQuerySchema,
    payoutSchema,
    transferSchema,
} from "./schemas.ts";

/**
 * Every endpoint that moves money requires an Idempotency-Key. Clients retry --
 * on a flaky network, on a double tap -- and without a key a retry is
 * indistinguishable from a second payment.
 */
function requireIdempotencyKey(request: FastifyRequest): string {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") {
        throw new MissingIdempotencyKey();
    }
    return key;
}

export interface AuthConfig {
    adminToken: string | undefined;
    sessionTtlSeconds: number;
}

/**
 * Idempotency keys are the client's, so they are kept apart per user: two
 * users choosing the same key must not collide, and one must never be handed
 * the stored response of the other's request.
 */
const scopedKey = (userId: bigint, key: string) => `user:${userId}:${key}`;

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function registerLedgerRoutes(
    app: FastifyInstance,
    pool: Pool,
    xpub: string,
    tokenAddress: string | undefined,
    auth: AuthConfig,
): void {
    // Signing up opens the account and signs in, in one step.
    app.post("/api/v1/users", async (request, reply) => {
        const { email, password } = createUserSchema.parse(request.body);
        let created;
        try {
            created = await createUser(pool, { email, xpub, passwordHash: await hashPassword(password) });
        } catch (error) {
            if (isUniqueViolation(error)) throw new EmailTaken();
            throw error;
        }
        const session = await createSession(pool, BigInt(created.userId), auth.sessionTtlSeconds);
        return reply.code(201).send({ ...created, token: session.token, expiresAt: session.expiresAt.toISOString() });
    });

    app.get("/api/v1/accounts/:id", async (request) => {
        const accountId = accountIdSchema.parse((request.params as { id: string }).id);
        await requireAccountOwner(pool, request, accountId);
        return getAccount(pool, accountId);
    });

    app.get("/api/v1/accounts/:id/entries", async (request) => {
        const accountId = accountIdSchema.parse((request.params as { id: string }).id);
        await requireAccountOwner(pool, request, accountId);
        const { cursor, limit } = entriesQuerySchema.parse(request.query);
        return listEntries(pool, accountId, { cursor, limit });
    });

    // A replayed request answers 200 with the stored result; a newly performed
    // one answers 201. Same body either way, so a retrying client cannot tell
    // the difference unless it looks.
    const respond = (reply: FastifyReply, outcome: { replayed: boolean; result: unknown }) =>
        reply.code(outcome.replayed ? 200 : 201).send(outcome.result);

    // Money enters only from the chain, through the indexer, and leaves only
    // to it, through /payouts. The ledger once had deposit and withdrawal
    // endpoints that credited and debited a simulated bank instead; nothing
    // backed those balances on chain, and proof of reserves would have had to
    // either count them or pretend they were not owed.

    // Paying another user needs only their account id; spending from an
    // account needs to own it.
    app.post("/api/v1/transfers", async (request, reply) => {
        const key = requireIdempotencyKey(request);
        const { fromAccountId, toAccountId, amount } = transferSchema.parse(request.body);
        const userId = await requireAccountOwner(pool, request, fromAccountId);
        return respond(
            reply,
            await transfer(pool, { fromAccountId, toAccountId, amount, idempotencyKey: scopedKey(userId, key) }),
        );
    });

    // An on-chain payout, as opposed to /withdrawals, which settles against the
    // gateway inside the ledger and never touches the chain.
    app.post("/api/v1/payouts", async (request, reply) => {
        const key = requireIdempotencyKey(request);
        const { accountId, to, amount } = payoutSchema.parse(request.body);
        const userId = await requireAccountOwner(pool, request, accountId);
        const idempotencyKey = scopedKey(userId, key);

        if (tokenAddress === undefined) {
            throw new PayoutsNotConfigured();
        }

        const result = await requestWithdrawal(pool, {
            accountId,
            to: to as Address,
            amount,
            tokenAddress,
            idempotencyKey,
        });

        // The funds are debited now and settle when the worker gets them on
        // chain, so this is an acceptance, not a completion.
        return reply.code(202).send(result);
    });

    app.get("/api/v1/admin/reconciliation", async (request, reply) => {
        requireAdmin(request, auth.adminToken);
        const result = await reconcile(pool);
        // A ledger that does not balance is an incident, so it answers with a
        // failing status an alert can watch rather than a cheerful 200.
        return reply.code(result.balanced ? 200 : 500).send(result);
    });
}
