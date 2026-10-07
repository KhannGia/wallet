import type { FastifyInstance } from "fastify";
import type { Address, Hex, PublicClient } from "viem";
import { z } from "zod";

import type { Pool } from "../db/pool.ts";
import { RecoveryNotConfigured } from "../aa/recovery/errors.ts";
import { retryRecovery } from "../aa/recovery/relayer.ts";
import {
    addRecoverySignature,
    createRecoveryRequest,
    getRecoveryRequest,
    openCancellation,
    type RecoveryRequest,
} from "../aa/recovery/requests.ts";
import { cancelTypedData, recoveryTypedData } from "../aa/recovery/typed-data.ts";
import { addressSchema, proposalIdSchema } from "./schemas.ts";

const unixSeconds = z
    .string()
    .regex(/^[1-9][0-9]*$/, "must be unix seconds as a decimal string")
    .transform((value) => BigInt(value));

const createSchema = z.object({ account: addressSchema, newOwner: addressSchema, deadline: unixSeconds });
const cancellationSchema = z.object({ deadline: unixSeconds });
const signatureSchema = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]*$/) });

/** Typed data goes out with integers as decimal strings, as eth_signTypedData_v4 takes them. */
function present(request: RecoveryRequest) {
    const approve = recoveryTypedData(request.module, request.chainId, {
        account: request.account,
        newOwner: request.newOwner,
        nonce: request.nonce,
        deadline: request.deadline,
    });
    const cancel =
        request.cancelDeadline === null
            ? null
            : cancelTypedData(request.module, request.chainId, {
                  account: request.account,
                  nonce: request.nonce + 1n,
                  deadline: request.cancelDeadline,
              });
    const stringify = <T extends { message: Record<string, unknown> }>(typed: T) => ({
        ...typed,
        message: Object.fromEntries(
            Object.entries(typed.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
        ),
    });

    return {
        id: request.id.toString(),
        module: request.module,
        chainId: request.chainId,
        account: request.account,
        newOwner: request.newOwner,
        nonce: request.nonce.toString(),
        deadline: request.deadline.toString(),
        threshold: request.threshold,
        status: request.status,
        executableAt: request.executableAt?.toString() ?? null,
        startTx: request.startTx,
        executeTx: request.executeTx,
        failure: request.failure,
        approvalTypedData: stringify(approve),
        cancellationTypedData: cancel === null ? null : stringify(cancel),
    };
}

/**
 * Social recovery over HTTP. Like the vault's routes these need no login to be
 * safe: anyone may open a request, but only a guardian's signature counts, and
 * the module checks every one again on chain. Submitting is the relayer's job.
 */
export function registerRecoveryRoutes(
    app: FastifyInstance,
    deps: { pool: Pool; client: PublicClient; module: string | undefined },
): void {
    const { pool, client } = deps;
    const requireModule = (): Address => {
        if (deps.module === undefined) throw new RecoveryNotConfigured();
        return deps.module as Address;
    };
    const idOf = (params: unknown) => proposalIdSchema.parse((params as { id: string }).id);

    app.post("/api/v1/recovery/requests", async (request, reply) => {
        const module = requireModule();
        const { account, newOwner, deadline } = createSchema.parse(request.body);
        const created = await createRecoveryRequest({ pool, client }, { module, account, newOwner, deadline });
        return reply.code(201).send(present(created));
    });

    app.get("/api/v1/recovery/requests/:id", async (request) => {
        requireModule();
        const detail = await getRecoveryRequest(pool, idOf(request.params));
        return { ...present(detail), approvals: detail.approvals, cancellations: detail.cancellations };
    });

    app.post("/api/v1/recovery/requests/:id/approvals", async (request, reply) => {
        requireModule();
        const { signature } = signatureSchema.parse(request.body);
        const receipt = await addRecoverySignature({ pool, client }, idOf(request.params), "APPROVE", signature as Hex);
        return reply.code(201).send({ ...receipt, ready: receipt.collected >= receipt.threshold });
    });

    // Guardians withdrawing a recovery that has started: first fix the
    // deadline they sign over, then collect their votes.
    app.post("/api/v1/recovery/requests/:id/cancellation", async (request) => {
        requireModule();
        const { deadline } = cancellationSchema.parse(request.body);
        return present(await openCancellation({ pool, client }, idOf(request.params), deadline));
    });

    app.post("/api/v1/recovery/requests/:id/cancellations", async (request, reply) => {
        requireModule();
        const { signature } = signatureSchema.parse(request.body);
        const receipt = await addRecoverySignature({ pool, client }, idOf(request.params), "CANCEL", signature as Hex);
        return reply.code(201).send({ ...receipt, ready: receipt.collected >= receipt.threshold });
    });

    app.post("/api/v1/recovery/requests/:id/retry", async (request) => {
        requireModule();
        const id = idOf(request.params);
        await retryRecovery(pool, id);
        return present(await getRecoveryRequest(pool, id));
    });
}
