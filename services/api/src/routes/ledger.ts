import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Address } from "viem";

import type { Pool } from "../db/pool.ts";
import { MissingIdempotencyKey, PayoutsNotConfigured } from "../ledger/errors.ts";
import {
    createUser,
    deposit,
    getAccount,
    listEntries,
    reconcile,
    transfer,
    withdraw,
} from "../ledger/operations.ts";
import { requestWithdrawal } from "../ledger/withdrawals.ts";
import {
    accountIdSchema,
    createUserSchema,
    depositSchema,
    entriesQuerySchema,
    payoutSchema,
    transferSchema,
    withdrawalSchema,
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

export function registerLedgerRoutes(
    app: FastifyInstance,
    pool: Pool,
    xpub: string,
    tokenAddress: string | undefined,
): void {
    app.post("/api/v1/users", async (request, reply) => {
        const { email } = createUserSchema.parse(request.body);
        return reply.code(201).send(await createUser(pool, { email, xpub }));
    });

    app.get("/api/v1/accounts/:id", async (request) => {
        const { id } = request.params as { id: string };
        return getAccount(pool, accountIdSchema.parse(id));
    });

    app.get("/api/v1/accounts/:id/entries", async (request) => {
        const { id } = request.params as { id: string };
        const { cursor, limit } = entriesQuerySchema.parse(request.query);
        return listEntries(pool, accountIdSchema.parse(id), { cursor, limit });
    });

    // A replayed request answers 200 with the stored result; a newly performed
    // one answers 201. Same body either way, so a retrying client cannot tell
    // the difference unless it looks.
    const respond = (reply: FastifyReply, outcome: { replayed: boolean; result: unknown }) =>
        reply.code(outcome.replayed ? 200 : 201).send(outcome.result);

    app.post("/api/v1/deposits", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const { accountId, amount } = depositSchema.parse(request.body);
        return respond(reply, await deposit(pool, { accountId, amount, idempotencyKey }));
    });

    app.post("/api/v1/withdrawals", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const { accountId, amount } = withdrawalSchema.parse(request.body);
        return respond(reply, await withdraw(pool, { accountId, amount, idempotencyKey }));
    });

    app.post("/api/v1/transfers", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const { fromAccountId, toAccountId, amount } = transferSchema.parse(request.body);
        return respond(
            reply,
            await transfer(pool, { fromAccountId, toAccountId, amount, idempotencyKey }),
        );
    });

    // An on-chain payout, as opposed to /withdrawals, which settles against the
    // gateway inside the ledger and never touches the chain.
    app.post("/api/v1/payouts", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const { accountId, to, amount } = payoutSchema.parse(request.body);

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

    app.get("/api/v1/admin/reconciliation", async (_request, reply) => {
        const result = await reconcile(pool);
        // A ledger that does not balance is an incident, so it answers with a
        // failing status an alert can watch rather than a cheerful 200.
        return reply.code(result.balanced ? 200 : 500).send(result);
    });
}
