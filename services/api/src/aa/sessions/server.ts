import { createHash, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { z, ZodError } from "zod";

import { addressSchema, proposalIdSchema } from "../../routes/schemas.ts";
import { SessionError, type SessionManager } from "./manager.ts";

const uint = z.string().regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer as a decimal string");

const createSchema = z.object({
    account: addressSchema,
    /** At most thirty days: a session is meant to run out. */
    validForSeconds: z.number().int().positive().max(30 * 24 * 3600),
    nativeLimit: uint.default("0").transform((v) => BigInt(v)),
    permissions: z
        .array(
            z.object({
                target: addressSchema,
                selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/, "selector must be 4 bytes of hex"),
                conditions: z
                    .array(
                        z.object({
                            param: z.number().int().min(0).max(255),
                            operator: z.enum(["eq", "lte", "gte"]),
                            value: z.string().min(1),
                        }),
                    )
                    .default([]),
            }),
        )
        .min(1)
        .max(20),
    limits: z
        .array(z.object({ token: addressSchema, limit: uint.transform((v) => BigInt(v)) }))
        .default([]),
});

const operationSchema = z.object({
    to: addressSchema,
    value: uint.default("0").transform((v) => BigInt(v)),
    data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "data must be whole bytes of hex").default("0x"),
    sponsored: z.boolean().default(false),
});

/** Constant-time comparison of a presented bearer token with the configured one. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
    if (presented === undefined) return false;
    // Hashed first so the comparison runs over equal lengths regardless of
    // input: timingSafeEqual itself requires it, and a length check would leak.
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

/**
 * The session manager over HTTP. Every route but /health needs the bearer
 * token: whoever can call these can spend, within each session's limits, from
 * every account that granted one.
 */
export function buildSessionServer(manager: SessionManager, token: string, logLevel = "info"): FastifyInstance {
    const app = Fastify({ logger: { level: logLevel } });

    app.get("/health", async () => ({ status: "ok" }));

    app.addHook("onRequest", async (request, reply) => {
        if (request.url === "/health") return;
        const header = request.headers.authorization;
        const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
        if (!tokenMatches(presented, token)) {
            return reply.code(401).send({ error: "unauthorized" });
        }
    });

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError) {
            return reply.code(400).send({ error: "invalid_request", issues: error.issues.map((i) => i.message) });
        }
        if (error instanceof SessionError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
        }
        // Nothing about the failure goes back: it could concern a key.
        request.log.error({ err: error }, "session manager failure");
        return reply.code(500).send({ error: "internal_error" });
    });

    const idOf = (params: unknown) => proposalIdSchema.parse((params as { id: string }).id);

    app.post("/sessions", async (request, reply) => {
        const body = createSchema.parse(request.body);
        const created = await manager.create({
            ...body,
            account: body.account as Address,
            permissions: body.permissions.map((p) => ({ ...p, target: p.target as Address, selector: p.selector as Hex })),
            limits: body.limits.map((l) => ({ token: l.token as Address, limit: l.limit })),
        });
        return reply.code(201).send({
            id: created.id.toString(),
            sessionKey: created.sessionKey,
            validUntil: created.validUntil.toString(),
            grant: created.grant,
        });
    });

    app.get("/sessions/:id", async (request) => manager.get(idOf(request.params)));

    app.post("/sessions/:id/operations", async (request) => {
        const body = operationSchema.parse(request.body);
        return manager.execute(
            idOf(request.params),
            { to: body.to as Address, value: body.value, data: body.data as Hex },
            { sponsored: body.sponsored },
        );
    });

    app.delete("/sessions/:id", async (request) => manager.revoke(idOf(request.params)));

    return app;
}
