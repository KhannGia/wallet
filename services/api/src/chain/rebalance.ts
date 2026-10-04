import type { Env } from "@wallet/shared";
import { encodeFunctionData, erc20Abi, type Address, type PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { vaultAbi } from "../vault/abi.ts";
import { createProposal } from "../vault/proposals.ts";

export interface RebalanceMarks {
    /** Below this available balance, the hot wallet asks the vault for a top-up. */
    low: bigint;
    /** Where a rebalance in either direction brings the balance. */
    target: bigint;
    /** Above this, the excess goes back to the vault. */
    high: bigint;
}

/** The configured marks, or undefined when rebalancing is switched off. */
export function rebalanceMarks(env: Env): RebalanceMarks | undefined {
    const { REBALANCE_LOW: low, REBALANCE_TARGET: target, REBALANCE_HIGH: high } = env;
    // loadEnv guarantees all three or none.
    if (low === undefined || target === undefined || high === undefined) return undefined;
    return { low, target, high };
}

/** One line for a log, or undefined when nothing happened worth logging. */
export function describePlan(plan: RebalancePlan): string | undefined {
    if (plan.action === "top_up") return `proposed a top-up of ${plan.amount} from the vault`;
    if (plan.action === "return_excess") return `queued ${plan.amount} back to the vault`;
    return undefined;
}

export type RebalancePlan =
    | { action: "none"; reason: string }
    | { action: "top_up"; amount: bigint }
    | { action: "return_excess"; amount: bigint };

/**
 * Decides what, if anything, should move between the hot wallet and the vault.
 *
 * Pure, so the policy can be tested without a chain: every input that comes
 * from the chain or the database is passed in.
 *
 * Between `low` and `high` nothing happens. That band is the point of having
 * two marks: a balance drifting around a single threshold would rebalance on
 * every pass, each time spending gas or an owner's signature.
 */
export function planRebalance(input: {
    available: bigint;
    marks: RebalanceMarks;
    /** A top-up proposal is already open, waiting for owners or the queue. */
    topUpOpen: boolean;
    /** A return to the vault is already on its way through the worker. */
    returnInFlight: boolean;
    /** What the vault's fast path may still send today. */
    vaultAllowance: bigint;
    vaultBalance: bigint;
}): RebalancePlan {
    const { available, marks } = input;

    if (available < marks.low) {
        if (input.topUpOpen) return { action: "none", reason: "a top-up is already open" };

        // Sized to the fast path, so the owners' signatures are all it takes:
        // a top-up the timelock held back for a day would not help a hot wallet
        // that is running dry now. If that leaves it short, the next pass after
        // this one executes asks again.
        const wanted = marks.target - available;
        const amount = [wanted, input.vaultAllowance, input.vaultBalance].reduce((a, b) =>
            a < b ? a : b,
        );
        if (amount <= 0n) {
            return { action: "none", reason: "the vault cannot send anything more today" };
        }
        return { action: "top_up", amount };
    }

    if (available > marks.high) {
        if (input.returnInFlight) return { action: "none", reason: "a return is already in flight" };
        return { action: "return_excess", amount: available - marks.target };
    }

    return { action: "none", reason: "within the band" };
}

/**
 * The hot wallet's token balance, minus what it has already promised.
 *
 * Payouts and returns that are reserved or in flight are about to leave, so
 * counting them would make the wallet look richer than it is. The estimate errs
 * low: a transfer that has been mined but not yet settled is subtracted twice
 * for a moment. Low is the safe side -- it can only make the rebalancer ask for
 * a little more, or return a little less.
 */
export async function availableHotBalance(
    pool: Pool,
    client: PublicClient,
    params: { token: Address; hotWallet: Address },
): Promise<bigint> {
    const [onChain, { rows }] = await Promise.all([
        client.readContract({
            address: params.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [params.hotWallet],
        }),
        pool.query<{ committed: bigint }>(
            `SELECT COALESCE(SUM(amount), 0)::BIGINT AS committed
               FROM chain_withdrawals
              WHERE lower(token_address) = lower($1) AND status IN ('PENDING', 'SUBMITTED')`,
            [params.token],
        ),
    ]);
    return onChain - (rows[0]?.committed ?? 0n);
}

async function topUpOpen(pool: Pool, vault: Address): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM vault_proposals
          WHERE kind = 'REBALANCE' AND lower(vault_address) = lower($1)
            AND status IN ('COLLECTING', 'QUEUED')
          LIMIT 1`,
        [vault],
    );
    return rows.length > 0;
}

async function returnInFlight(pool: Pool): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1 FROM chain_withdrawals
          WHERE kind = 'REBALANCE' AND status IN ('PENDING', 'SUBMITTED')
          LIMIT 1`,
    );
    return rows.length > 0;
}

export interface RebalanceConfig {
    token: Address;
    vault: Address;
    hotWallet: Address;
    marks: RebalanceMarks;
}

/** Reads everything planRebalance needs, from the chain and the database. */
export async function assessRebalance(
    pool: Pool,
    client: PublicClient,
    config: RebalanceConfig,
): Promise<RebalancePlan> {
    const [available, vaultAllowance, vaultBalance, open, inFlight] = await Promise.all([
        availableHotBalance(pool, client, { token: config.token, hotWallet: config.hotWallet }),
        client.readContract({
            address: config.vault,
            abi: vaultAbi,
            functionName: "remainingToday",
            args: [config.token],
        }),
        client.readContract({
            address: config.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [config.vault],
        }),
        topUpOpen(pool, config.vault),
        returnInFlight(pool),
    ]);

    return planRebalance({
        available,
        marks: config.marks,
        topUpOpen: open,
        returnInFlight: inFlight,
        vaultAllowance,
        vaultBalance,
    });
}

/**
 * Cold -> hot. Opens a vault proposal to top the hot wallet up, when one is due.
 *
 * It only proposes. Moving reserves out of the vault takes owners' signatures,
 * and a process that signed on their behalf would make the multisig a
 * formality. Runs in the vault submitter, which holds no key to the hot wallet.
 *
 * Refuses outright if the vault would send the top-up anywhere but the hot
 * wallet the withdrawal worker registered: the fast path pays `hotWallet()`,
 * and a vault pointed elsewhere would be topping up the wrong account.
 */
export async function proposeTopUp(
    deps: { pool: Pool; client: PublicClient },
    config: RebalanceConfig & { proposalTtlSeconds: number },
): Promise<RebalancePlan & { proposalId?: bigint }> {
    const { pool, client } = deps;

    const vaultHot = await client.readContract({
        address: config.vault,
        abi: vaultAbi,
        functionName: "hotWallet",
    });
    if (vaultHot.toLowerCase() !== config.hotWallet.toLowerCase()) {
        throw new Error(
            `the vault tops up ${vaultHot}, but the registered hot wallet is ${config.hotWallet}; ` +
                "refusing to propose a top-up to an account the withdrawal worker does not sign for",
        );
    }

    const plan = await assessRebalance(pool, client, config);
    if (plan.action !== "top_up") return plan;

    const now = (await client.getBlock()).timestamp;
    const proposal = await createProposal(deps, {
        vault: config.vault,
        to: config.token,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [config.hotWallet, plan.amount],
        }),
        deadline: now + BigInt(config.proposalTtlSeconds),
        kind: "REBALANCE",
    });
    return { ...plan, proposalId: proposal.id };
}

/**
 * Hot -> cold. Queues the hot wallet's excess for the withdrawal worker to send
 * to the vault, when it holds too much.
 *
 * Only queues a row: the worker signs it, with the nonce it allocates, exactly
 * as it sends a payout. Runs inside the withdrawal worker for that reason.
 */
export async function queueExcessReturn(
    pool: Pool,
    client: PublicClient,
    config: RebalanceConfig,
): Promise<RebalancePlan & { withdrawalId?: bigint }> {
    const plan = await assessRebalance(pool, client, config);
    if (plan.action !== "return_excess") return plan;

    const { rows } = await pool.query<{ id: bigint }>(
        `INSERT INTO chain_withdrawals (kind, to_address, token_address, amount, status)
         VALUES ('REBALANCE', $1, $2, $3, 'PENDING')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [config.vault, config.token, plan.amount],
    );
    const row = rows[0];
    // Another worker queued one between the check and the insert.
    if (row === undefined) return { action: "none", reason: "a return is already in flight" };
    return { ...plan, withdrawalId: row.id };
}
