import type { FastifyInstance } from "fastify";
import { zeroAddress, type Address, type PublicClient } from "viem";
import { z } from "zod";

import type { Pool } from "../db/pool.ts";
import { GraduationNotConfigured } from "../graduation/errors.ts";
import {
    cancelGraduation,
    fundGraduation,
    getGraduation,
    GRADUATION_SALT,
    openGraduation,
    type Graduation,
    type GraduationConfig,
} from "../graduation/graduations.ts";
import { accountIdSchema, addressSchema, proposalIdSchema } from "./schemas.ts";

const openSchema = z.object({
    // The factory refuses a zero owner, so the activation could never happen.
    owner: addressSchema.refine((owner) => owner !== zeroAddress, "owner must not be the zero address"),
});

/**
 * Amounts as decimal strings. The factory and salt go out too: they are what
 * the user's wallet puts in the initCode of the operation that deploys it.
 */
function present(graduation: Graduation, factory: Address) {
    return {
        id: graduation.id.toString(),
        accountId: graduation.accountId.toString(),
        owner: graduation.owner,
        smartAccount: graduation.smartAccount,
        factory,
        salt: GRADUATION_SALT.toString(),
        status: graduation.status,
        amount: graduation.amount?.toString() ?? null,
        withdrawalId: graduation.withdrawalId?.toString() ?? null,
        failure: graduation.failure,
    };
}

/**
 * Graduation over HTTP: open, activate (on chain, by the user), fund.
 *
 * Like /payouts, these trust the caller to be the account's holder: the API has
 * no user authentication yet, and the threat model says so.
 */
export function registerGraduationRoutes(
    app: FastifyInstance,
    deps: { pool: Pool; client: PublicClient; factory: string | undefined; token: string | undefined },
): void {
    const { pool, client } = deps;
    const requireConfig = (): GraduationConfig => {
        if (deps.factory === undefined || deps.token === undefined) throw new GraduationNotConfigured();
        return { factory: deps.factory as Address, token: deps.token as Address };
    };
    const idOf = (params: unknown) => proposalIdSchema.parse((params as { id: string }).id);

    app.post("/api/v1/accounts/:id/graduation", async (request, reply) => {
        const config = requireConfig();
        const accountId = accountIdSchema.parse((request.params as { id: string }).id);
        const { owner } = openSchema.parse(request.body);
        const { graduation, created } = await openGraduation({ pool, client }, config, { accountId, owner });
        return reply.code(created ? 201 : 200).send(present(graduation, config.factory));
    });

    app.get("/api/v1/graduations/:id", async (request) => {
        const config = requireConfig();
        return present(await getGraduation(pool, idOf(request.params)), config.factory);
    });

    // Called once the user's activation operation has landed. Accepted rather
    // than done: the balance is reserved now and arrives when the worker
    // settles the transfer.
    app.post("/api/v1/graduations/:id/funding", async (request, reply) => {
        const config = requireConfig();
        const graduation = await fundGraduation({ pool, client }, config, idOf(request.params));
        return reply.code(202).send(present(graduation, config.factory));
    });

    app.post("/api/v1/graduations/:id/cancellation", async (request) => {
        const config = requireConfig();
        return present(await cancelGraduation(pool, idOf(request.params)), config.factory);
    });
}
