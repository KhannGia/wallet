import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";

import { buildApp, createDeps, type AppDeps } from "../app.ts";

describe("client configuration", () => {
    let deps: AppDeps;
    before(() => {
        deps = createDeps(loadEnv({ ...process.env, LOG_LEVEL: "error" }));
    });
    after(async () => {
        await deps.pool.end();
    });

    it("tells a client the network, the token and every contract, null where none is deployed", async () => {
        const vault = "0x00000000000000000000000000000000000000aa";
        const app = buildApp({
            ...deps,
            env: { ...deps.env, VAULT_ADDRESS: vault, RESERVES_REGISTRY_ADDRESS: undefined },
        });
        const response = await app.inject({ method: "GET", url: "/api/v1/config" });
        await app.close();

        assert.equal(response.statusCode, 200);
        const config = response.json();
        assert.equal(config.chainId, deps.env.CHAIN_ID);
        assert.deepEqual(config.token, { address: deps.env.USDC_ADDRESS ?? null, symbol: "USDC", decimals: 6 });
        assert.equal(config.entryPoint, "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
        assert.equal(config.vault, vault);
        assert.equal(config.reservesRegistry, null);
    });
});
