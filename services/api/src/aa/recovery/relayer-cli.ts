// Entry point for `./wallet recovery-relayer`. Starts recoveries that have a
// guardian quorum, executes them once their delay passes, and relays guardian
// cancellations.
//
// Its key only pays gas -- the guardians' signatures authorise everything -- but
// it is still a key, so it runs apart from the API, like every other signer.
import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createChainClient } from "../../chain/client.ts";
import { assertDistinctSigners } from "../../chain/signer-roles.ts";
import { createPool } from "../../db/pool.ts";
import { runRecoveryRelayOnce } from "./relayer.ts";

const env = loadEnv();

if (env.RECOVERY_RELAYER_PRIVATE_KEY === undefined || env.GUARDIAN_MODULE_ADDRESS === undefined) {
    console.error(
        "The recovery relayer needs GUARDIAN_MODULE_ADDRESS (./wallet deploy-aa prints it)\n" +
            "and RECOVERY_RELAYER_PRIVATE_KEY, a key of its own that only pays gas.",
    );
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

const account = privateKeyToAccount(env.RECOVERY_RELAYER_PRIVATE_KEY as `0x${string}`);
const client = createChainClient(env.RPC_URL);
const wallet = createWalletClient({ account, transport: http(env.RPC_URL) });
const pool = createPool(env.DATABASE_URL);

const code = await client.getCode({ address: env.GUARDIAN_MODULE_ADDRESS as Address });
if (code === undefined || code === "0x") {
    console.error(`No contract found at GUARDIAN_MODULE_ADDRESS ${env.GUARDIAN_MODULE_ADDRESS}.`);
    process.exit(1);
}

console.log(`recovery relayer paying gas from ${account.address}`);

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

while (running) {
    try {
        for (const { id, outcome } of await runRecoveryRelayOnce({ pool, client, wallet })) {
            // A recovery waiting out its 48 hours is reported every pass.
            if (outcome.kind === "waiting") continue;
            console.log(`recovery ${id}: ${outcome.kind}${"reason" in outcome ? ` ${outcome.reason}` : ""}`);
        }
    } catch (error) {
        console.error("relay pass failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.RECOVERY_POLL_MS));
}

await pool.end();
