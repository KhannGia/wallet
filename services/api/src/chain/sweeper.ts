import { signingAccountForIndex } from "@wallet/shared";
import {
    createWalletClient,
    encodeFunctionData,
    http,
    type Address,
    type PublicClient,
    type WalletClient,
} from "viem";

import type { Pool } from "../db/pool.ts";
import { receiptMovedTokens } from "./receipts.ts";
import { planSweeps, sweepable, type SweepConfig } from "./sweep-planner.ts";

const ERC20_TRANSFER_ABI = [
    {
        type: "function",
        name: "transfer",
        inputs: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable",
    },
] as const;

export interface SweeperConfig extends SweepConfig {
    /** Where the swept tokens go. */
    hotWallet: Address;

    /** Native currency sent to an address that cannot pay for its own transfer. */
    gasFundingWei: bigint;

    /** Derives the key for each deposit address. */
    mnemonic: string;
}

export interface SweeperDeps {
    pool: Pool;
    client: PublicClient;
    /** Pays the gas funding. In practice the same hot wallet that pays out. */
    funder: WalletClient;
    rpcUrl: string;
}

export interface SweepRunResult {
    planned: number;
    funded: number;
    swept: number;
    sweptAmount: bigint;
    failures: string[];
}

/**
 * Empties deposit addresses into the hot wallet.
 *
 * Deliberately stateless. A sweep moves tokens between two addresses the wallet
 * already controls, so no user's balance changes and there is nothing to record
 * in the ledger -- the deposit was credited when it arrived, and where the
 * tokens physically sit afterwards is a custody detail. That also makes the
 * pass naturally idempotent: it re-reads balances every time, so a crash
 * halfway simply leaves work for the next run.
 */
export async function runSweepsOnce(
    deps: SweeperDeps,
    config: SweeperConfig,
): Promise<SweepRunResult> {
    const candidates = sweepable(await planSweeps(deps, config));

    let funded = 0;
    let swept = 0;
    let sweptAmount = 0n;
    const failures: string[] = [];

    for (const candidate of candidates) {
        try {
            if (candidate.decision === "needs_gas") {
                const funderAccount = deps.funder.account;
                if (funderAccount === undefined) {
                    throw new Error("sweeper has no funding account");
                }

                const fundingHash = await deps.funder.sendTransaction({
                    account: funderAccount,
                    chain: null,
                    to: candidate.address,
                    value: config.gasFundingWei,
                });
                await deps.client.waitForTransactionReceipt({ hash: fundingHash });
                funded += 1;
            }

            // The key is derived here and nowhere else. Passing the address the
            // xpub produced turns a mismatched mnemonic into an immediate
            // failure rather than a signature over the wrong account.
            const account = signingAccountForIndex(
                config.mnemonic,
                candidate.derivationIndex,
                candidate.address,
            );

            const wallet = createWalletClient({ account, transport: http(deps.rpcUrl) });

            const hash = await wallet.sendTransaction({
                account,
                chain: null,
                to: config.token,
                data: encodeFunctionData({
                    abi: ERC20_TRANSFER_ABI,
                    functionName: "transfer",
                    args: [config.hotWallet, candidate.tokenBalance],
                }),
            });

            const receipt = await deps.client.waitForTransactionReceipt({ hash });

            if (
                receipt.status !== "success" ||
                !receiptMovedTokens(receipt, {
                    token: config.token,
                    to: config.hotWallet,
                    amount: candidate.tokenBalance,
                })
            ) {
                failures.push(
                    `${candidate.address}: transaction ${hash} did not move the tokens`,
                );
                continue;
            }

            swept += 1;
            sweptAmount += candidate.tokenBalance;
        } catch (error) {
            // One address failing must not stop the rest: a single unsweepable
            // deposit should not strand every other user's funds.
            failures.push(
                `${candidate.address}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    return { planned: candidates.length, funded, swept, sweptAmount, failures };
}
