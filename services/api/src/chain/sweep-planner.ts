import type { Address, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";

const ERC20_BALANCE_ABI = [
    {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

/**
 * Gas a sweep costs, in units.
 *
 * An ERC-20 transfer to an address that already holds a balance is around
 * 50k; 65k leaves room for the first transfer into a fresh slot, which writes
 * a new storage word and costs considerably more. Funding is a plain value
 * transfer at the protocol minimum.
 */
const TRANSFER_GAS = 65_000n;
const FUNDING_GAS = 21_000n;

export interface SweepConfig {
    token: Address;

    /**
     * Below this, tokens stay where they are.
     *
     * Deciding whether a sweep is worth its gas really means comparing a token
     * amount against a native-currency cost, which needs a price feed this
     * project does not have. The threshold is the honest stand-in: an operator
     * sets it knowing roughly what gas costs, and the estimate below is
     * reported so they can revisit it.
     */
    minTokenBalance: bigint;
}

export type SweepDecision = "ready" | "needs_gas" | "below_minimum" | "empty";

export interface SweepCandidate {
    accountId: string;
    address: Address;
    derivationIndex: number;
    tokenBalance: bigint;
    nativeBalance: bigint;
    estimatedGasCostWei: bigint;
    decision: SweepDecision;
}

/**
 * Works out which deposit addresses are worth emptying.
 *
 * Nothing here signs or sends. Deciding and acting are separate so the decision
 * can be inspected -- and got wrong -- without moving anyone's funds.
 */
export async function planSweeps(
    deps: { pool: Pool; client: PublicClient },
    config: SweepConfig,
): Promise<SweepCandidate[]> {
    const { rows } = await deps.pool.query<{
        account_id: bigint;
        deposit_address: string;
        derivation_index: bigint;
    }>(
        `SELECT id AS account_id, deposit_address, derivation_index
           FROM accounts
          WHERE type = 'USER' AND deposit_address IS NOT NULL
          ORDER BY derivation_index`,
    );

    if (rows.length === 0) {
        return [];
    }

    const fees = await deps.client.estimateFeesPerGas();

    // One request per address. A production wallet batches these through
    // Multicall3, which this devnet does not have deployed; the shape of the
    // result is the same either way.
    const balances = await Promise.all(
        rows.map(async (row) => {
            const address = row.deposit_address as Address;

            const [tokenBalance, nativeBalance] = await Promise.all([
                deps.client.readContract({
                    address: config.token,
                    abi: ERC20_BALANCE_ABI,
                    functionName: "balanceOf",
                    args: [address],
                }),
                deps.client.getBalance({ address }),
            ]);

            return { row, address, tokenBalance, nativeBalance };
        }),
    );

    return balances.map(({ row, address, tokenBalance, nativeBalance }) => {
        const transferCost = TRANSFER_GAS * fees.maxFeePerGas;

        // A deposit address holds tokens and nothing else. It cannot pay for
        // its own transfer, so the sweep costs two transactions, not one.
        const needsGas = nativeBalance < transferCost;
        const estimatedGasCostWei = needsGas
            ? transferCost + FUNDING_GAS * fees.maxFeePerGas
            : transferCost;

        let decision: SweepDecision;
        if (tokenBalance === 0n) {
            decision = "empty";
        } else if (tokenBalance < config.minTokenBalance) {
            decision = "below_minimum";
        } else if (needsGas) {
            decision = "needs_gas";
        } else {
            decision = "ready";
        }

        return {
            accountId: String(row.account_id),
            address,
            derivationIndex: Number(row.derivation_index),
            tokenBalance,
            nativeBalance,
            estimatedGasCostWei,
            decision,
        };
    });
}

/** The addresses a sweeper would act on, in derivation order. */
export function sweepable(candidates: SweepCandidate[]): SweepCandidate[] {
    return candidates.filter(
        (candidate) => candidate.decision === "ready" || candidate.decision === "needs_gas",
    );
}
