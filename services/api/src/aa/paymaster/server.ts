import Fastify, { type FastifyInstance } from "fastify";

import { SponsorshipRefused, type Sponsor } from "./sponsor.ts";

/** JSON-RPC error codes. -32602 is the standard "invalid params". */
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * The paymaster web service, as ERC-7677 defines it: JSON-RPC over HTTP with
 * pm_getPaymasterStubData and pm_getPaymasterData. Any wallet or SDK that
 * speaks ERC-7677 -- viem's paymaster client included -- can use it unchanged.
 *
 * A separate server from the API, because it holds a key: its signature spends
 * the paymaster's deposit.
 */
export function buildPaymasterServer(sponsor: Sponsor, logLevel = "info"): FastifyInstance {
    const app = Fastify({ logger: { level: logLevel } });

    app.get("/health", async () => ({ status: "ok" }));

    app.post("/", async (request) => {
        const body = request.body as { id?: unknown; method?: unknown; params?: unknown };
        const id = body?.id ?? null;
        const params = Array.isArray(body?.params) ? body.params : [];
        const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

        const handler =
            body?.method === "pm_getPaymasterStubData"
                ? sponsor.stubData
                : body?.method === "pm_getPaymasterData"
                  ? sponsor.paymasterData
                  : undefined;
        if (handler === undefined) return fail(METHOD_NOT_FOUND, `method ${String(body?.method)} not supported`);

        try {
            return { jsonrpc: "2.0", id, result: await handler(params[0], params[1], params[2]) };
        } catch (error) {
            // A refusal is an answer, not a fault: the wallet is told why.
            if (error instanceof SponsorshipRefused) return fail(INVALID_PARAMS, error.message);
            request.log.error({ err: error }, "sponsorship failed");
            return fail(INTERNAL_ERROR, "internal error");
        }
    });

    return app;
}
