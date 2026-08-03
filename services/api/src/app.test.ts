import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";

import { buildApp, createDeps, type AppDeps } from "./app.ts";

describe("health endpoints", () => {
  let deps: AppDeps;
  let app: ReturnType<typeof buildApp>;

  before(() => {
    deps = createDeps(loadEnv({ ...process.env, LOG_LEVEL: "error" }));
    app = buildApp(deps);
  });

  after(async () => {
    await app.close();
    await deps.pool.end();
  });

  it("reports liveness without touching any dependency", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  });

  // This is the P0 acceptance test: it only passes when Postgres and anvil are
  // both reachable, which proves the whole compose stack is wired correctly.
  it("reports readiness once Postgres and the chain both answer", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    const body = response.json();

    assert.equal(response.statusCode, 200, `not ready: ${JSON.stringify(body)}`);
    assert.equal(body.ready, true);
    assert.match(body.checks.database.detail, /PostgreSQL/);
    assert.match(body.checks.chain.detail, /^block \d+$/);
  });
});
