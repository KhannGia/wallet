// Entry point for `./wallet withdrawer`. Polls for payouts and settles them.
//
// This is the only process that holds a key able to move funds. It is a
// separate service from the API for exactly that reason: compromising the API
// server gives an attacker no way to spend.
import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createPool } from "../db/pool.ts";
import { createChainClient } from "./client.ts";
import { registerHotWallet, syncNonceWithChain } from "./nonce.ts";
import { describePlan, queueExcessReturn, rebalanceMarks } from "./rebalance.ts";
import { assertDistinctSigners, HOT_WALLET_ID } from "./signer-roles.ts";
import { runWithdrawalWorkerOnce, type WorkerConfig } from "./withdrawal-worker.ts";

const env = loadEnv();

if (env.HOT_WALLET_PRIVATE_KEY === undefined) {
    console.error(
        "HOT_WALLET_PRIVATE_KEY is not set. Generate a throwaway devnet key with\n" +
            "`./wallet cast wallet new` and put it in .env. Never use a key that holds\n" +
            "anything of value, and never commit it.",
    );
    process.exit(1);
}

try {
    assertDistinctSigners({
        HOT_WALLET_PRIVATE_KEY: env.HOT_WALLET_PRIVATE_KEY,
        GAS_FUNDER_PRIVATE_KEY: env.GAS_FUNDER_PRIVATE_KEY,
        VAULT_SUBMITTER_PRIVATE_KEY: env.VAULT_SUBMITTER_PRIVATE_KEY,
        PAYMASTER_SIGNER_PRIVATE_KEY: env.PAYMASTER_SIGNER_PRIVATE_KEY,
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}

const account = privateKeyToAccount(env.HOT_WALLET_PRIVATE_KEY as `0x${string}`);
const client = createChainClient(env.RPC_URL);
const wallet = createWalletClient({ account, transport: http(env.RPC_URL) });
const pool = createPool(env.DATABASE_URL);


const config: WorkerConfig = {
    hotWalletId: HOT_WALLET_ID,
    stuckAfterMs: env.STUCK_AFTER_MS,
    feeBumpPercent: BigInt(env.FEE_BUMP_PERCENT),
    maxBroadcastAttempts: env.MAX_BROADCAST_ATTEMPTS,
};

if (env.USDC_ADDRESS === undefined) {
    console.error("USDC_ADDRESS is not set; there is no token to pay out.");
    process.exit(1);
}

// A call to an address with no code succeeds without doing anything, so a
// misconfigured token would produce healthy-looking receipts for payouts that
// never happened. Better to refuse to start.
const tokenCode = await client.getCode({ address: env.USDC_ADDRESS as `0x${string}` });
if (tokenCode === undefined || tokenCode === "0x") {
    console.error(
        `No contract found at USDC_ADDRESS ${env.USDC_ADDRESS}. ` +
            "On a devnet this usually means anvil was restarted and the token needs redeploying.",
    );
    process.exit(1);
}

const startNonce = BigInt(
    await client.getTransactionCount({ address: account.address, blockTag: "pending" }),
);
await registerHotWallet(pool, HOT_WALLET_ID, account.address, startNonce);

// Only ever moves the counter forward, covering a restore from an older backup
// or a second signer that used the same key.
const sync = await syncNonceWithChain(pool, HOT_WALLET_ID, account.address, client);
console.log(
    `withdrawal worker signing from ${account.address} | ` +
        `nonce ${sync.storedNext} (chain ${sync.chainCount}, ${sync.action})`,
);

// Hot -> cold rebalancing, if configured: when the hot wallet holds more than it
// needs, queue the excess back to the vault. The worker sends it like a payout,
// on the same nonce sequence -- which is why it is planned here and nowhere else.
const marks = rebalanceMarks(env);
if (marks !== undefined && env.VAULT_ADDRESS === undefined) {
    console.error("Rebalancing is configured but VAULT_ADDRESS is not; there is nowhere to return excess.");
    process.exit(1);
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

while (running) {
    try {
        if (marks !== undefined) {
            const plan = await queueExcessReturn(pool, client, {
                token: env.USDC_ADDRESS as Address,
                vault: env.VAULT_ADDRESS as Address,
                hotWallet: account.address,
                marks,
            });
            const line = describePlan(plan);
            if (line !== undefined) console.log(`rebalance: ${line}`);
        }

        const result = await runWithdrawalWorkerOnce({ pool, client, wallet }, config);

        const activity =
            result.reserved + result.broadcast + result.confirmed +
            result.failed + result.replaced + result.abandoned;

        if (activity > 0) {
            console.log(
                `reserved ${result.reserved} | broadcast ${result.broadcast} | ` +
                    `confirmed ${result.confirmed} | failed ${result.failed} | ` +
                    `replaced ${result.replaced} | abandoned ${result.abandoned}`,
            );
        }
    } catch (error) {
        // A failed pass is survivable: nonces stay attached to their rows, so
        // the next pass resumes exactly where this one stopped. Crashing would
        // freeze payouts until somebody noticed.
        console.error("withdrawal pass failed:", error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, env.WITHDRAWAL_POLL_MS));
}

await pool.end();
