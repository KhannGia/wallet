// Entry point for `./wallet paymaster`: the ERC-7677 sponsorship service.
//
// Holds the key whose signatures spend the paymaster's deposit, so it runs as
// its own process, apart from the API server, like every other signer here.
import { loadEnv } from "@wallet/shared";
import { parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint08Address } from "viem/account-abstraction";

import { createChainClient } from "../../chain/client.ts";
import { assertDistinctSigners } from "../../chain/signer-roles.ts";
import { createPool } from "../../db/pool.ts";
import { buildPaymasterServer } from "./server.ts";
import { createSponsor } from "./sponsor.ts";

const env = loadEnv();

const missing = [
    ["PAYMASTER_SIGNER_PRIVATE_KEY", env.PAYMASTER_SIGNER_PRIVATE_KEY],
    ["PAYMASTER_ADDRESS", env.PAYMASTER_ADDRESS],
    ["ACCOUNT_FACTORY_ADDRESS", env.ACCOUNT_FACTORY_ADDRESS],
    ["USDC_ADDRESS", env.USDC_ADDRESS],
]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
if (missing.length > 0) {
    console.error(`The paymaster service needs ${missing.join(", ")}. ./wallet deploy-aa prints the addresses.`);
    process.exit(1);
}

try {
    assertDistinctSigners({
        HOT_WALLET_PRIVATE_KEY: env.HOT_WALLET_PRIVATE_KEY,
        GAS_FUNDER_PRIVATE_KEY: env.GAS_FUNDER_PRIVATE_KEY,
        VAULT_SUBMITTER_PRIVATE_KEY: env.VAULT_SUBMITTER_PRIVATE_KEY,
        PAYMASTER_SIGNER_PRIVATE_KEY: env.PAYMASTER_SIGNER_PRIVATE_KEY,
        RECOVERY_RELAYER_PRIVATE_KEY: env.RECOVERY_RELAYER_PRIVATE_KEY,
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

const signer = privateKeyToAccount(env.PAYMASTER_SIGNER_PRIVATE_KEY as `0x${string}`);
const paymaster = env.PAYMASTER_ADDRESS as Address;
const client = createChainClient(env.RPC_URL);
const pool = createPool(env.DATABASE_URL);

// The paymaster accepts one signer's sponsorships only. Signing with any other
// key would produce sponsorships every bundler rejects, so refuse to start.
const trusted = await client
    .readContract({
        address: paymaster,
        abi: parseAbi(["function signer() view returns (address)"]),
        functionName: "signer",
    })
    .catch(() => undefined);
if (trusted === undefined || trusted.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(
        `No VerifyingPaymaster trusting ${signer.address} at ${paymaster}` +
            (trusted ? ` (it trusts ${trusted})` : "") +
            ". Redeploy with ./wallet deploy-aa after changing the signer key.",
    );
    process.exit(1);
}

const sponsor = createSponsor(
    { pool, client, signer },
    {
        paymaster,
        entryPoint: entryPoint08Address,
        chainId: env.CHAIN_ID,
        factory: env.ACCOUNT_FACTORY_ADDRESS as Address,
        token: env.USDC_ADDRESS as Address,
        dailyCapWei: env.PAYMASTER_DAILY_GAS_CAP_WEI,
        ttlSeconds: env.PAYMASTER_SPONSORSHIP_TTL_SECONDS,
    },
);
const app = buildPaymasterServer(sponsor, env.LOG_LEVEL);
await app.listen({ host: "0.0.0.0", port: env.PAYMASTER_PORT });
console.log(`paymaster service for ${paymaster} signing as ${signer.address} on :${env.PAYMASTER_PORT}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
        void (async () => {
            await app.close();
            await pool.end();
            process.exit(0);
        })();
    });
}
