// Entry point for `./wallet indexer`. Polls the chain forever.
import { loadEnv, localChain } from "@wallet/shared";
import { createPublicClient, http, type Address } from "viem";

import { createPool } from "../db/pool.ts";
import { runIndexerOnce, type IndexerConfig } from "./indexer.ts";
import type { FinalityStrategy } from "./finality.ts";

const env = loadEnv();

if (env.USDC_ADDRESS === undefined) {
    console.error(
        "USDC_ADDRESS is not set. Deploy the devnet token with `./wallet deploy-token`\n" +
            "and put the address it prints into .env.",
    );
    process.exit(1);
}

const finality: FinalityStrategy =
    env.FINALITY_MODE === "confirmations"
        ? { kind: "confirmations", depth: BigInt(env.FINALITY_CONFIRMATIONS) }
        : { kind: "finalized-tag" };

const config: IndexerConfig = {
    scannerId: "usdc",
    token: env.USDC_ADDRESS as Address,
    startBlock: env.INDEXER_START_BLOCK,
    finality,
};

const pool = createPool(env.DATABASE_URL);
const client = createPublicClient({ chain: localChain, transport: http(env.RPC_URL) });

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

console.log(
    `indexer watching ${config.token} from block ${config.startBlock}, ` +
        `finality=${finality.kind === "confirmations" ? `${finality.depth} confirmations` : "finalized tag"}`,
);

while (running) {
    try {
        const result = await runIndexerOnce({ pool, client }, config);

        if (result.recorded > 0 || result.confirmed > 0) {
            console.log(
                `blocks ${result.scannedFrom ?? "-"}..${result.scannedTo ?? "-"} | ` +
                    `recorded ${result.recorded} | confirmed ${result.confirmed} | cursor ${result.cursor}`,
            );
        }
    } catch (error) {
        // A failed pass is survivable: the cursor only advances after a range
        // is recorded, so the next pass retries it. Crashing the process would
        // stall deposits until someone noticed.
        console.error("indexer pass failed:", error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, env.INDEXER_POLL_MS));
}

await pool.end();
