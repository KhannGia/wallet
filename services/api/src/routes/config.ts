import { USDC_DECIMALS } from "@wallet/shared";
import type { FastifyInstance } from "fastify";
import { entryPoint08Address } from "viem/account-abstraction";

import type { Env } from "@wallet/shared";

/**
 * What a client needs to talk to the chain on its own: the network, the token
 * and the contracts. Public, and nothing in it is secret -- every address is
 * on chain for anyone to see. A contract that is not deployed is null.
 */
export function registerConfigRoutes(app: FastifyInstance, env: Env): void {
    const config = {
        chainId: env.CHAIN_ID,
        token: { address: env.USDC_ADDRESS ?? null, symbol: "USDC", decimals: USDC_DECIMALS },
        entryPoint: entryPoint08Address,
        accountFactory: env.ACCOUNT_FACTORY_ADDRESS ?? null,
        paymaster: env.PAYMASTER_ADDRESS ?? null,
        guardianModule: env.GUARDIAN_MODULE_ADDRESS ?? null,
        reservesRegistry: env.RESERVES_REGISTRY_ADDRESS ?? null,
        vault: env.VAULT_ADDRESS ?? null,
    };
    app.get("/api/v1/config", async () => config);
}
