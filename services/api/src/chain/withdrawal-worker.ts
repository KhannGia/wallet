import {
    encodeFunctionData,
    type Address,
    type Hash,
    type PublicClient,
    type WalletClient,
} from "viem";

import { withTransaction, type Pool } from "../db/pool.ts";
import { refundWithdrawal, settleWithdrawal } from "../ledger/withdrawals.ts";
import { allocateNonce } from "./nonce.ts";
import { receiptMovedTokens } from "./receipts.ts";

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

export interface WorkerConfig {
    hotWalletId: string;
    /** How long a transaction may sit unmined before it is replaced. */
    stuckAfterMs: number;
    /**
     * Fee increase when replacing. Nodes require at least 10%; going slightly
     * above avoids a replacement being rejected over integer rounding.
     */
    feeBumpPercent: bigint;

    /**
     * How many times a broadcast may fail before the withdrawal is abandoned.
     *
     * Retrying forever is not an option: the row holds a nonce, and every later
     * transaction queues behind it. After this many attempts the worker spends
     * the nonce on an empty self-transfer, refunds the user, and lets the queue
     * move again.
     */
    maxBroadcastAttempts: number;
}

export interface WorkerDeps {
    pool: Pool;
    client: PublicClient;
    wallet: WalletClient;
}

export interface WorkerRunResult {
    reserved: number;
    broadcast: number;
    confirmed: number;
    failed: number;
    replaced: number;
    /** Withdrawals given up on, their nonce released. */
    abandoned: number;
}

interface PendingRow {
    id: bigint;
    to_address: string;
    token_address: string;
    amount: bigint;
}

interface InFlightRow {
    id: bigint;
    to_address: string;
    token_address: string;
    amount: bigint;
    nonce: bigint;
    transaction_hash: string | null;
    max_fee_per_gas: bigint | null;
    max_priority_fee_per_gas: bigint | null;
    submitted_at: Date | null;
    broadcast_failures: number;
}

/**
 * Claims a nonce for every pending withdrawal.
 *
 * Separate from broadcasting on purpose. The nonce, the SUBMITTED status and
 * the wallet are committed together, so a crash before the transaction reaches
 * the node leaves a row that still knows which nonce it owns. The next pass
 * rebroadcasts with that same nonce rather than allocating a fresh one, which
 * would leave a hole that stalls every later withdrawal.
 */
async function reserveNonces(deps: WorkerDeps, config: WorkerConfig): Promise<number> {
    const { rows } = await deps.pool.query<PendingRow>(
        `SELECT id, to_address, token_address, amount
           FROM chain_withdrawals WHERE status = 'PENDING' ORDER BY id`,
    );

    for (const row of rows) {
        await withTransaction(deps.pool, async (client) => {
            const nonce = await allocateNonce(client, config.hotWalletId);

            await client.query(
                `UPDATE chain_withdrawals
                    SET status = 'SUBMITTED', nonce = $2, hot_wallet_id = $3,
                        submitted_at = now()
                  WHERE id = $1 AND status = 'PENDING'`,
                [row.id, nonce, config.hotWalletId],
            );
        });
    }

    return rows.length;
}

async function sendTransfer(
    deps: WorkerDeps,
    row: InFlightRow,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Promise<Hash> {
    const account = deps.wallet.account;
    if (account === undefined) {
        throw new Error("withdrawal worker has no signing account");
    }

    return deps.wallet.sendTransaction({
        account,
        chain: null,
        to: row.token_address as Address,
        data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: "transfer",
            args: [row.to_address as Address, row.amount],
        }),
        nonce: Number(row.nonce),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
}

/** Broadcasts anything that holds a nonce but has never reached the node. */
/**
 * Spends a nonce on an empty self-transfer so the queue behind it can move.
 *
 * The transaction this replaces never reached the node, so the nonce is simply
 * unused rather than contested: an ordinary transaction claims it.
 */
async function releaseNonce(deps: WorkerDeps, row: InFlightRow): Promise<void> {
    const account = deps.wallet.account;
    if (account === undefined) {
        throw new Error("withdrawal worker has no signing account");
    }

    const fees = await deps.client.estimateFeesPerGas();

    await deps.wallet.sendTransaction({
        account,
        chain: null,
        to: account.address,
        value: 0n,
        nonce: Number(row.nonce),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
}

async function broadcastUnsent(
    deps: WorkerDeps,
    config: WorkerConfig,
): Promise<{ broadcast: number; abandoned: number }> {
    const { rows } = await deps.pool.query<InFlightRow>(
        `SELECT id, to_address, token_address, amount, nonce, transaction_hash,
                max_fee_per_gas, max_priority_fee_per_gas, submitted_at, broadcast_failures
           FROM chain_withdrawals
          WHERE status = 'SUBMITTED' AND transaction_hash IS NULL
          ORDER BY nonce`,
    );

    let broadcast = 0;
    let abandoned = 0;

    for (const row of rows) {
        try {
            const estimate = await deps.client.estimateFeesPerGas();
            const fees = {
                maxFeePerGas: estimate.maxFeePerGas,
                maxPriorityFeePerGas: estimate.maxPriorityFeePerGas,
            };

            const hash = await sendTransfer(deps, row, fees);

            await deps.pool.query(
                `UPDATE chain_withdrawals
                    SET transaction_hash = $2, max_fee_per_gas = $3,
                        max_priority_fee_per_gas = $4, attempts = attempts + 1,
                        submitted_at = now()
                  WHERE id = $1`,
                [row.id, hash, fees.maxFeePerGas, fees.maxPriorityFeePerGas],
            );

            broadcast += 1;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const failures = row.broadcast_failures + 1;

            await deps.pool.query(
                "UPDATE chain_withdrawals SET broadcast_failures = $2, failure = $3 WHERE id = $1",
                [row.id, failures, reason],
            );

            if (failures < config.maxBroadcastAttempts) {
                continue;
            }

            // Out of attempts. Free the nonce before refunding, so the queue
            // moves even if the refund itself has to be retried.
            await releaseNonce(deps, row);
            await refundWithdrawal(deps.pool, row.id, `broadcast failed: ${reason}`);
            abandoned += 1;
        }
    }

    return { broadcast, abandoned };
}

/** Turns mined transactions into ledger movements. */
async function settleMined(deps: WorkerDeps): Promise<{ confirmed: number; failed: number }> {
    const { rows } = await deps.pool.query<InFlightRow>(
        `SELECT id, to_address, token_address, amount, nonce, transaction_hash,
                max_fee_per_gas, max_priority_fee_per_gas, submitted_at, broadcast_failures
           FROM chain_withdrawals
          WHERE status = 'SUBMITTED' AND transaction_hash IS NOT NULL
          ORDER BY id`,
    );

    let confirmed = 0;
    let failed = 0;

    for (const row of rows) {
        let receipt;
        try {
            receipt = await deps.client.getTransactionReceipt({
                hash: row.transaction_hash as Hash,
            });
        } catch {
            // Not mined yet, or replaced by another attempt. Either way there is
            // nothing to settle on this pass.
            continue;
        }

        if (receipt.status === "success") {
            const moved = receiptMovedTokens(receipt, {
                token: row.token_address,
                to: row.to_address,
                amount: row.amount,
            });

            if (!moved) {
                // Mined, successful, and yet no tokens moved. The usual cause is
                // a token address with no contract behind it. Refusing to settle
                // keeps the ledger honest; the funds stay reserved and the
                // failure is recorded for an operator to look at.
                if (
                    await refundWithdrawal(
                        deps.pool,
                        row.id,
                        "transaction succeeded but emitted no matching Transfer; " +
                            "check the configured token address",
                    )
                ) {
                    failed += 1;
                }
                continue;
            }

            if (await settleWithdrawal(deps.pool, row.id)) confirmed += 1;
        } else {
            // The transaction was mined and reverted -- an ERC-20 transfer that
            // failed, for instance. The gas is spent but no tokens moved, so the
            // user gets their reservation back.
            if (await refundWithdrawal(deps.pool, row.id, "transaction reverted on chain")) {
                failed += 1;
            }
        }
    }

    return { confirmed, failed };
}

/**
 * Resends anything that has sat unmined for too long, at a higher fee.
 *
 * A stuck transaction is not merely its own problem: every later nonce queues
 * behind it, so one underpriced withdrawal freezes all of them. The replacement
 * must carry the same nonce, which is why the nonce is stored on the row.
 */
async function replaceStuck(deps: WorkerDeps, config: WorkerConfig): Promise<number> {
    const cutoff = new Date(Date.now() - config.stuckAfterMs);

    const { rows } = await deps.pool.query<InFlightRow>(
        `SELECT id, to_address, token_address, amount, nonce, transaction_hash,
                max_fee_per_gas, max_priority_fee_per_gas, submitted_at, broadcast_failures
           FROM chain_withdrawals
          WHERE status = 'SUBMITTED' AND transaction_hash IS NOT NULL
            AND submitted_at < $1
          ORDER BY nonce`,
        [cutoff],
    );

    let replaced = 0;

    for (const row of rows) {
        try {
            await deps.client.getTransactionReceipt({ hash: row.transaction_hash as Hash });
            // Already mined; settleMined will deal with it.
            continue;
        } catch {
            // Genuinely still waiting.
        }

        const bump = (value: bigint): bigint =>
            (value * (100n + config.feeBumpPercent)) / 100n;

        const previousMax = row.max_fee_per_gas;
        const previousPriority = row.max_priority_fee_per_gas;
        if (previousMax === null || previousPriority === null) {
            continue;
        }

        const fees = {
            maxFeePerGas: bump(previousMax),
            maxPriorityFeePerGas: bump(previousPriority),
        };

        const hash = await sendTransfer(deps, row, fees);

        await deps.pool.query(
            `UPDATE chain_withdrawals
                SET transaction_hash = $2, max_fee_per_gas = $3,
                    max_priority_fee_per_gas = $4, attempts = attempts + 1,
                    submitted_at = now()
              WHERE id = $1`,
            [row.id, hash, fees.maxFeePerGas, fees.maxPriorityFeePerGas],
        );

        replaced += 1;
    }

    return replaced;
}

/** One pass: reserve, broadcast, settle what mined, replace what stalled. */
export async function runWithdrawalWorkerOnce(
    deps: WorkerDeps,
    config: WorkerConfig,
): Promise<WorkerRunResult> {
    const reserved = await reserveNonces(deps, config);
    const { broadcast, abandoned } = await broadcastUnsent(deps, config);
    const { confirmed, failed } = await settleMined(deps);
    const replaced = await replaceStuck(deps, config);

    return { reserved, broadcast, confirmed, failed, replaced, abandoned };
}
