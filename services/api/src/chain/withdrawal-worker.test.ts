import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import type { Address } from "viem";

import { withTransaction, type Pool } from "../db/pool.ts";
import { InsufficientFunds } from "../ledger/errors.ts";
import { createUser, deposit, getAccount } from "../ledger/operations.ts";
import { requestWithdrawal, reservedBalance } from "../ledger/withdrawals.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    fundSigner,
    setIntervalMining,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { assertBalanced, resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { allocateNonce, peekNonce, registerHotWallet } from "./nonce.ts";
import { runWithdrawalWorkerOnce, type WorkerConfig, type WorkerDeps } from "./withdrawal-worker.ts";

const HOT_WALLET = "hot";

describe("withdrawal worker", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let signer: Signer;
    let token: Address;

    const config: WorkerConfig = {
        hotWalletId: HOT_WALLET,
        stuckAfterMs: 60_000,
        feeBumpPercent: 12n,
        maxBroadcastAttempts: 3,
    };

    let deps: WorkerDeps;

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        // Index 8: well away from 0, which is both the deployer and the first
        // derived deposit address.
        signer = anvilSigner(env.RPC_URL, 8);
        token = await deployMockUsdc(harness);
        await fundSigner(harness, token, signer, 1_000_000_000n);

        deps = { pool, client: harness.publicClient, wallet: signer.walletClient };
    });

    beforeEach(async () => {
        await resetDatabase(pool);
        const chainNonce = await harness.publicClient.getTransactionCount({
            address: signer.address,
            blockTag: "pending",
        });
        await registerHotWallet(pool, HOT_WALLET, signer.address, BigInt(chainNonce));
    });

    after(async () => {
        // Restore mining, or every later test waits forever.
        await setIntervalMining(harness, 2);
        await pool.end();
    });

    const fundedAccount = async (email: string, amount: bigint) => {
        const user = await createUser(pool, { email, xpub: TEST_XPUB });
        const accountId = BigInt(user.accountId);
        await deposit(pool, { accountId, amount, idempotencyKey: `seed-${email}` });
        return accountId;
    };

    const tokenBalance = async (address: Address): Promise<bigint> =>
        harness.publicClient.readContract({
            address: token,
            abi: [
                {
                    type: "function",
                    name: "balanceOf",
                    inputs: [{ name: "", type: "address" }],
                    outputs: [{ name: "", type: "uint256" }],
                    stateMutability: "view",
                },
            ] as const,
            functionName: "balanceOf",
            args: [address],
        });

    it("moves tokens on chain and settles the ledger", async () => {
        const accountId = await fundedAccount("payout@test.local", 500_000n);
        const destination = "0x000000000000000000000000000000000000bEEF" as Address;
        const before = await tokenBalance(destination);

        await requestWithdrawal(pool, {
            accountId,
            to: destination,
            amount: 200_000n,
            tokenAddress: token,
            idempotencyKey: "wd-1",
        });

        // Debited immediately: the same balance must not be spendable twice
        // while the transaction is in flight.
        assert.equal((await getAccount(pool, accountId)).balance, "300000");
        assert.equal(await reservedBalance(pool, accountId), 200_000n);

        const first = await runWithdrawalWorkerOnce(deps, config);
        assert.equal(first.reserved, 1);
        assert.equal(first.broadcast, 1);

        // Give the chain a block, then settle.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const second = await runWithdrawalWorkerOnce(deps, config);

        assert.equal(second.confirmed, 1);
        assert.equal(await tokenBalance(destination), before + 200_000n, "tokens must arrive");
        assert.equal(await reservedBalance(pool, accountId), 0n);
        assert.equal((await getAccount(pool, accountId)).balance, "300000");
        await assertBalanced(pool);
    });

    it("refuses a withdrawal larger than the balance before it reaches the chain", async () => {
        const accountId = await fundedAccount("over@test.local", 1_000n);

        await assert.rejects(
            requestWithdrawal(pool, {
                accountId,
                to: "0x000000000000000000000000000000000000bEEF" as Address,
                amount: 1_001n,
                tokenAddress: token,
                idempotencyKey: "wd-over",
            }),
            InsufficientFunds,
        );

        assert.equal((await getAccount(pool, accountId)).balance, "1000");
        await assertBalanced(pool);
    });

    it("assigns contiguous nonces to concurrent withdrawals", async () => {
        const accountId = await fundedAccount("many@test.local", 100_000n);
        const startNonce = await peekNonce(pool, HOT_WALLET);

        await Promise.all(
            Array.from({ length: 5 }, (_unused, i) =>
                requestWithdrawal(pool, {
                    accountId,
                    to: "0x000000000000000000000000000000000000bEEF" as Address,
                    amount: 1_000n,
                    tokenAddress: token,
                    idempotencyKey: `wd-many-${i}`,
                }),
            ),
        );

        await runWithdrawalWorkerOnce(deps, config);

        const { rows } = await pool.query<{ nonce: bigint }>(
            "SELECT nonce FROM chain_withdrawals ORDER BY nonce",
        );
        assert.deepEqual(
            rows.map((row) => row.nonce),
            Array.from({ length: 5 }, (_unused, i) => startNonce + BigInt(i)),
            "a gap here would stall every later withdrawal",
        );
    });

    it("rebroadcasts with the same nonce when a send never reached the node", async () => {
        const accountId = await fundedAccount("crash@test.local", 50_000n);
        await requestWithdrawal(pool, {
            accountId,
            to: "0x000000000000000000000000000000000000bEEF" as Address,
            amount: 10_000n,
            tokenAddress: token,
            idempotencyKey: "wd-crash",
        });

        const { rows } = await pool.query<{ id: bigint }>("SELECT id FROM chain_withdrawals LIMIT 1");
        const row = rows[0];
        assert.ok(row);

        // Reproduce the exact state a crash leaves behind: the nonce and the
        // SUBMITTED status are committed, but the transaction never reached the
        // node, so there is no hash. This is what reserveNonces does before
        // broadcasting.
        const assignedNonce = await withTransaction(pool, async (client) => {
            const nonce = await allocateNonce(client, HOT_WALLET);
            await client.query(
                `UPDATE chain_withdrawals
                    SET status = 'SUBMITTED', nonce = $2, hot_wallet_id = $3, submitted_at = now()
                  WHERE id = $1`,
                [row.id, nonce, HOT_WALLET],
            );
            return nonce;
        });

        const counterBefore = await peekNonce(pool, HOT_WALLET);

        const result = await runWithdrawalWorkerOnce(deps, config);

        assert.equal(result.reserved, 0, "no fresh nonce may be allocated");
        assert.equal(result.broadcast, 1);

        const { rows: after } = await pool.query<{ nonce: bigint; transaction_hash: string | null }>(
            "SELECT nonce, transaction_hash FROM chain_withdrawals WHERE id = $1",
            [row.id],
        );

        // Reusing the nonce is the whole point: allocating a fresh one would
        // leave a hole that stalls every later withdrawal behind it.
        assert.equal(after[0]?.nonce, assignedNonce);
        assert.ok(after[0]?.transaction_hash, "it must actually be sent this time");
        assert.equal(await peekNonce(pool, HOT_WALLET), counterBefore);
    });

    it("refuses to settle when a successful transaction moved no tokens", async () => {
        const accountId = await fundedAccount("phantom@test.local", 90_000n);

        // An address with no contract behind it. Calling it succeeds -- there
        // is no code to revert -- so the receipt looks perfectly healthy while
        // nothing at all happened. Settling on that would have the ledger
        // record a payout the chain never made.
        const codeless = "0x00000000000000000000000000000000DeaDBeef" as Address;

        await requestWithdrawal(pool, {
            accountId,
            to: "0x000000000000000000000000000000000000bEEF" as Address,
            amount: 30_000n,
            tokenAddress: codeless,
            idempotencyKey: "wd-phantom",
        });

        await runWithdrawalWorkerOnce(deps, config);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const result = await runWithdrawalWorkerOnce(deps, config);

        assert.equal(result.confirmed, 0, "a payout that moved nothing must not settle");
        assert.equal(result.failed, 1);

        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM chain_withdrawals WHERE token_address = $1",
            [codeless],
        );
        assert.equal(rows[0]?.status, "FAILED");

        // The user gets their money back rather than losing it to a phantom
        // transfer.
        assert.equal((await getAccount(pool, accountId)).balance, "90000");
        await assertBalanced(pool);
    });

    it("replaces a stuck transaction with the same nonce at a higher fee", async () => {
        const accountId = await fundedAccount("stuck@test.local", 80_000n);
        await requestWithdrawal(pool, {
            accountId,
            to: "0x000000000000000000000000000000000000bEEF" as Address,
            amount: 20_000n,
            tokenAddress: token,
            idempotencyKey: "wd-stuck",
        });

        // Stop mining so the transaction genuinely stays in the mempool.
        await setIntervalMining(harness, 0);
        try {
            await runWithdrawalWorkerOnce(deps, config);

            const { rows: before } = await pool.query<{
                nonce: bigint;
                transaction_hash: string;
                max_fee_per_gas: bigint;
                attempts: number;
            }>("SELECT nonce, transaction_hash, max_fee_per_gas, attempts FROM chain_withdrawals LIMIT 1");
            const original = before[0];
            assert.ok(original?.transaction_hash);

            // Treat anything in flight as stuck, then run again.
            const result = await runWithdrawalWorkerOnce(deps, {
                ...config,
                stuckAfterMs: 0,
            });
            assert.equal(result.replaced, 1);

            const { rows: after } = await pool.query<{
                nonce: bigint;
                transaction_hash: string;
                max_fee_per_gas: bigint;
                attempts: number;
            }>("SELECT nonce, transaction_hash, max_fee_per_gas, attempts FROM chain_withdrawals LIMIT 1");
            const replacement = after[0];
            assert.ok(replacement);

            // Same slot in the queue, different transaction, higher price.
            assert.equal(replacement.nonce, original.nonce);
            assert.notEqual(replacement.transaction_hash, original.transaction_hash);
            assert.ok(
                replacement.max_fee_per_gas > original.max_fee_per_gas,
                "a node rejects a replacement that does not raise the fee",
            );
            assert.equal(replacement.attempts, original.attempts + 1);
        } finally {
            await setIntervalMining(harness, 2);
        }
    });
});
