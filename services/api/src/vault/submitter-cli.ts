// Entry point for `./wallet vault-submitter`. Submits vault proposals once
// their owners have reached quorum.
//
// Its key only pays gas. It cannot move a single wei out of the vault on its
// own -- the owners' signatures do that -- but it is still a key, so it lives
// here and not in the API server.
import { loadEnv } from "@wallet/shared";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createChainClient } from "../chain/client.ts";
import { describePlan, proposeTopUp, rebalanceMarks } from "../chain/rebalance.ts";
import { assertDistinctSigners, registeredHotWallet } from "../chain/signer-roles.ts";
import { createPool } from "../db/pool.ts";
import { submitReadyProposals } from "./submitter.ts";

const env = loadEnv();

if (env.VAULT_SUBMITTER_PRIVATE_KEY === undefined || env.VAULT_ADDRESS === undefined) {
    console.error(
        "The vault submitter needs VAULT_ADDRESS and VAULT_SUBMITTER_PRIVATE_KEY.\n" +
            "The submitter key only pays gas, but it must not be HOT_WALLET_PRIVATE_KEY:\n" +
            "the withdrawal worker allocates that account's nonces itself.",
    );
    process.exit(1);
}

const account = privateKeyToAccount(env.VAULT_SUBMITTER_PRIVATE_KEY as `0x${string}`);

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

const client = createChainClient(env.RPC_URL);
const wallet = createWalletClient({ account, transport: http(env.RPC_URL) });
const pool = createPool(env.DATABASE_URL);

// The same check the withdrawer makes for its token: a vault address with no
// code accepts every call and does nothing, which would look like success.
const code = await client.getCode({ address: env.VAULT_ADDRESS as Address });
if (code === undefined || code === "0x") {
    console.error(`No contract found at VAULT_ADDRESS ${env.VAULT_ADDRESS}.`);
    process.exit(1);
}

console.log(`vault submitter paying gas from ${account.address} for vault ${env.VAULT_ADDRESS}`);

// Cold -> hot rebalancing, if configured: when the hot wallet runs low, open a
// top-up proposal for the owners to sign. Proposing needs no key at all.
const marks = rebalanceMarks(env);
if (marks !== undefined && env.USDC_ADDRESS === undefined) {
    console.error("Rebalancing is configured but USDC_ADDRESS is not; there is no token to move.");
    process.exit(1);
}

async function rebalance(): Promise<void> {
    if (marks === undefined || env.USDC_ADDRESS === undefined) return;
    const plan = await proposeTopUp(
        { pool, client },
        {
            token: env.USDC_ADDRESS as Address,
            vault: env.VAULT_ADDRESS as Address,
            // Read each pass: the withdrawal worker may register after this starts.
            hotWallet: await registeredHotWallet(pool),
            marks,
            proposalTtlSeconds: env.REBALANCE_PROPOSAL_TTL_SECONDS,
        },
    );
    const line = describePlan(plan);
    if (line !== undefined) console.log(`rebalance: ${line} (proposal ${plan.proposalId})`);
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        running = false;
    });
}

while (running) {
    try {
        for (const { id, outcome } of await submitReadyProposals({ pool, client, wallet })) {
            // A queued call waiting out its delay is reported every pass;
            // logging each one would bury everything else.
            if (outcome.kind === "waiting") continue;
            const detail =
                outcome.kind === "executed" ? outcome.transactionHash
                : outcome.kind === "queued" ? `${outcome.transactionHash} (executable at ${outcome.eta})`
                : "reason" in outcome ? outcome.reason
                : "";
            console.log(`proposal ${id}: ${outcome.kind} ${detail}`.trimEnd());
        }

        await rebalance();
    } catch (error) {
        // Nothing is half-done between passes: a proposal is either recorded
        // as settled or still collecting, so the next pass simply looks again.
        console.error("submission pass failed:", error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, env.VAULT_SUBMIT_POLL_MS));
}

await pool.end();
