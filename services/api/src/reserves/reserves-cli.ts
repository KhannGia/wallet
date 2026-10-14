// Entry point for `./wallet reserves`. Snapshots reserves against liabilities
// on a timer and publishes each Merkle root to the registry.
//
// Its key can only write attestations -- it moves no money -- but the registry
// trusts that key alone, so it runs apart from the API like every other signer.
import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createChainClient } from "../chain/client.ts";
import { USDC_SCANNER_ID } from "../chain/indexer.ts";
import { assertDistinctSigners, signingKeys } from "../chain/signer-roles.ts";
import { createPool } from "../db/pool.ts";
import { runReservesOnce } from "./publisher.ts";

const env = loadEnv();

if (env.USDC_ADDRESS === undefined) {
    console.error("The reserves worker needs USDC_ADDRESS (./wallet deploy-token prints it).");
    process.exit(1);
}
const publishing = env.RESERVES_REGISTRY_ADDRESS !== undefined || env.RESERVES_PUBLISHER_PRIVATE_KEY !== undefined;
if (publishing && (env.RESERVES_REGISTRY_ADDRESS === undefined || env.RESERVES_PUBLISHER_PRIVATE_KEY === undefined)) {
    console.error(
        "To publish, set both RESERVES_PUBLISHER_PRIVATE_KEY and RESERVES_REGISTRY_ADDRESS\n" +
            "(./wallet deploy-reserves prints it); leave both unset to only take snapshots.",
    );
    process.exit(1);
}

try {
    assertDistinctSigners(signingKeys(env));
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

const client = createChainClient(env.RPC_URL);
const pool = createPool(env.DATABASE_URL);
const registry = env.RESERVES_REGISTRY_ADDRESS as Address | undefined;
const account =
    env.RESERVES_PUBLISHER_PRIVATE_KEY === undefined
        ? undefined
        : privateKeyToAccount(env.RESERVES_PUBLISHER_PRIVATE_KEY as `0x${string}`);

// The registry accepts one key. Publishing with any other would fail on every
// pass, so refuse to start instead.
if (registry !== undefined && account !== undefined) {
    const trusted = await client
        .readContract({ address: registry, abi: parseAbi(["function publisher() view returns (address)"]), functionName: "publisher" })
        .catch(() => undefined);
    if (trusted === undefined || trusted.toLowerCase() !== account.address.toLowerCase()) {
        console.error(
            `No ReservesRegistry trusting ${account.address} at ${registry}` +
                (trusted ? ` (it trusts ${trusted})` : "") +
                ". Redeploy with ./wallet deploy-reserves after changing the key.",
        );
        process.exit(1);
    }
}
const wallet = account === undefined ? undefined : createWalletClient({ account, transport: http(env.RPC_URL) });

console.log(registry === undefined ? "reserves worker: snapshots only" : `reserves worker publishing to ${registry}`);

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

while (running) {
    try {
        const run = await runReservesOnce(
            { pool, client, ...(wallet === undefined ? {} : { wallet }) },
            {
                token: env.USDC_ADDRESS as Address,
                ...(env.VAULT_ADDRESS === undefined ? {} : { vault: env.VAULT_ADDRESS as Address }),
                scannerId: USDC_SCANNER_ID,
                ...(registry === undefined ? {} : { registry }),
            },
        );
        const line = `snapshot ${run.snapshotId}: surplus ${run.surplus}, ${run.publication.kind}` +
            ("reason" in run.publication ? ` (${run.publication.reason})` : "");
        // A shortfall is an incident: it goes to stderr, where alerting looks.
        if (run.solvent) console.log(line);
        else console.error(`SHORTFALL ${line}`);
        if (run.recovered > 0) console.log(`recorded ${run.recovered} earlier publication(s) found on chain`);
    } catch (error) {
        console.error("reserves pass failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, env.RESERVES_POLL_MS));
}

await pool.end();
