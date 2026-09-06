import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { LedgerError } from "../ledger/errors.ts";

export function registerErrorHandler(app: FastifyInstance): void {
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError) {
            return reply.code(400).send({
                error: "invalid_request",
                issues: error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }

        // Deliberate business outcomes carry their own status. Anything else is
        // a bug, and is logged and returned as a 500 rather than dressed up as
        // an expected result.
        if (error instanceof LedgerError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
        }

        request.log.error({ err: error }, "unhandled error");
        return reply.code(500).send({ error: "internal_error" });
    });
}
