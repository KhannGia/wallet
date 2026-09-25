// Entry point for `./wallet sweeper`.
//
// Holds the mnemonic, which derives the key for every deposit address, so it
// runs as its own process and nowhere near the API server. Compromising the API
// still gives an attacker nothing that can spend.
import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createPool } from "../db/pool.ts";
import { createChainClient } from "./client.ts";
import { runSweepsOnce, type SweeperConfig } from "./sweeper.ts";

const env = loadEnv();

const missing = [
    env.WALLET_MNEMONIC === undefined ? "WALLET_MNEMONIC" : null,
    env.USDC_ADDRESS === undefined ? "USDC_ADDRESS" : null,
    env.HOT_WALLET_PRIVATE_KEY === undefined ? "HOT_WALLET_PRIVATE_KEY" : null,
].filter((name): name is string => name !== null);

if (missing.length > 0 || env.WALLET_MNEMONIC === undefined || env.USDC_ADDRESS === undefined) {
    console.error(
        `The sweeper needs ${missing.join(", ")}.\n` +
            "WALLET_MNEMONIC must be the phrase WALLET_XPUB was derived from; a mismatch is\n" +
            "caught before anything is signed, but it will stop every sweep until fixed.",
    );
    process.exit(1);
}

const client = createChainClient(env.RPC_URL);

// The hot wallet both pays the gas funding and receives the swept tokens.
const hot = privateKeyToAccount(env.HOT_WALLET_PRIVATE_KEY as `0x${string}`);
const funder = createWalletClient({ account: hot, transport: http(env.RPC_URL) });
const pool = createPool(env.DATABASE_URL);

const config: SweeperConfig = {
    token: env.USDC_ADDRESS as Address,
    minTokenBalance: env.MIN_SWEEP_BALANCE,
    hotWallet: hot.address,
    gasFundingWei: env.SWEEP_GAS_FUNDING_WEI,
    mnemonic: env.WALLET_MNEMONIC,
};

console.log(
    `sweeper consolidating ${config.token} into ${config.hotWallet} | ` +
        `minimum ${config.minTokenBalance}`,
);

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

while (running) {
    try {
        const result = await runSweepsOnce({ pool, client, funder, rpcUrl: env.RPC_URL }, config);

        if (result.planned > 0) {
            console.log(
                `planned ${result.planned} | funded ${result.funded} | ` +
                    `swept ${result.swept} (${result.sweptAmount})`,
            );
        }

        for (const failure of result.failures) {
            console.error(`sweep failed: ${failure}`);
        }
    } catch (error) {
        // Nothing is recorded, so a failed pass costs only the gas already
        // spent. The next pass re-reads balances and picks up where this left
        // off.
        console.error("sweep pass failed:", error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, env.SWEEP_POLL_MS));
}

await pool.end();
