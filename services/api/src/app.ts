import Fastify, { type FastifyInstance } from "fastify";
import { createPublicClient, http } from "viem";

import { loadEnv, type Env } from "@wallet/shared";

import { createPool, type Pool } from "./db/pool.ts";
import { registerErrorHandler } from "./routes/errors.ts";
import { registerLedgerRoutes } from "./routes/ledger.ts";

export interface AppDeps {
  env: Env;
  pool: Pool;
  chain: ReturnType<typeof createPublicClient>;
}

export function createDeps(env: Env = loadEnv()): AppDeps {
  return {
    env,
    pool: createPool(env.DATABASE_URL),
    chain: createPublicClient({ transport: http(env.RPC_URL) }),
  };
}

type CheckResult = { ok: true; detail: string } | { ok: false; error: string };

async function check(fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { ok: true, detail: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: deps.env.LOG_LEVEL } });

  // Liveness: is the process itself running? Deliberately touches no
  // dependency, so an orchestrator does not restart the API because Postgres
  // happens to be down.
  app.get("/health/live", async () => ({ status: "ok" }));

  // Readiness: can this instance actually serve traffic?
  app.get("/health/ready", async (_request, reply) => {
    const [database, chain] = await Promise.all([
      check(async () => {
        const { rows } = await deps.pool.query<{ version: string }>("SELECT version() AS version");
        return rows[0]?.version ?? "unknown";
      }),
      check(async () => {
        const blockNumber = await deps.chain.getBlockNumber();
        return `block ${blockNumber}`;
      }),
    ]);

    const ready = database.ok && chain.ok;
    return reply.code(ready ? 200 : 503).send({ ready, checks: { database, chain } });
  });

  registerErrorHandler(app);
  registerLedgerRoutes(app, deps.pool, deps.env.WALLET_XPUB);

  return app;
}
