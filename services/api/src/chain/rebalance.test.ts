import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain } from "@wallet/shared";
import {
    createWalletClient,
    erc20Abi,
    http,
    type Address,
    type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Pool } from "../db/pool.ts";
import { createUser, deposit, reconcile } from "../ledger/operations.ts";
import { refundWithdrawal, requestWithdrawal } from "../ledger/withdrawals.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    deployMultisigVault,
    mintTo,
    sendEther,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { assertBalanced, resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { addSignature, getProposal, type Proposal } from "../vault/proposals.ts";
import { submitReadyProposals } from "../vault/submitter.ts";
import { executeTypedData } from "../vault/typed-data.ts";
import { registerHotWallet } from "./nonce.ts";
import {
    planRebalance,
    proposeTopUp,
    queueExcessReturn,
    type RebalanceConfig,
    type RebalanceMarks,
} from "./rebalance.ts";
import { HOT_WALLET_ID } from "./signer-roles.ts";
import { runWithdrawalWorkerOnce } from "./withdrawal-worker.ts";

const MARKS: RebalanceMarks = { low: 1_000n, target: 5_000n, high: 20_000n };

describe("rebalancing policy", () => {
    const plan = (overrides: Partial<Parameters<typeof planRebalance>[0]>) =>
        planRebalance({
            available: 10_000n,
            marks: MARKS,
            topUpOpen: false,
            returnInFlight: false,
            vaultAllowance: 1_000_000n,
            vaultBalance: 1_000_000n,
            ...overrides,
        });

    it("does nothing inside the band, edges included", () => {
        for (const available of [MARKS.low, 10_000n, MARKS.high]) {
            assert.equal(plan({ available }).action, "none");
        }
    });

    it("tops up to the target when the balance falls below the low mark", () => {
        assert.deepEqual(plan({ available: 400n }), { action: "top_up", amount: 4_600n });
    });

    it("never asks for more than the fast path or the vault can give", () => {
        assert.deepEqual(plan({ available: 0n, vaultAllowance: 3_000n }), {
            action: "top_up",
            amount: 3_000n,
        });
        assert.deepEqual(plan({ available: 0n, vaultBalance: 2_000n }), {
            action: "top_up",
            amount: 2_000n,
        });
        assert.equal(plan({ available: 0n, vaultAllowance: 0n }).action, "none");
    });

    it("returns the excess above the high mark, down to the target", () => {
        assert.deepEqual(plan({ available: 32_000n }), {
            action: "return_excess",
            amount: 27_000n,
        });
    });

    it("never stacks a second move on one still in progress", () => {
        assert.equal(plan({ available: 0n, topUpOpen: true }).action, "none");
        assert.equal(plan({ available: 32_000n, returnInFlight: true }).action, "none");
    });
});

describe("rebalancing against a vault", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let rpcUrl: string;
    let submitter: Signer;
    let token: Address;
    let owners: PrivateKeyAccount[];
    let vault: Address;
    let hot: PrivateKeyAccount;

    before(async () => {
        rpcUrl = loadEnv({ ...process.env, LOG_LEVEL: "error" }).RPC_URL;
        pool = testPool();
        harness = chainHarness(rpcUrl);
        submitter = anvilSigner(rpcUrl, 3);
        token = await deployMockUsdc(harness);
    });

    /**
     * A fresh hot wallet and a fresh 3-of-5 vault holding a million token
     * units, which may send up to `allowance` a day to that hot wallet at once.
     */
    async function setUp(options: { hotBalance: bigint; allowance?: bigint; vaultPays?: Address }) {
        hot = privateKeyToAccount(generatePrivateKey());
        owners = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())).sort(
            (a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1),
        );
        vault = await deployMultisigVault(harness, owners.map((o) => o.address), 3n, {
            delay: 3600n,
            hotWallet: options.vaultPays ?? hot.address,
            assets: [token],
            limits: [options.allowance ?? 1_000_000n],
        });
        await mintTo(harness, token, vault, 1_000_000n);
        if (options.hotBalance > 0n) await mintTo(harness, token, hot.address, options.hotBalance);
        await registerHotWallet(pool, HOT_WALLET_ID, hot.address, 0n);
    }

    const config = (): RebalanceConfig => ({ token, vault, hotWallet: hot.address, marks: MARKS });

    const tokenBalance = (address: Address) =>
        harness.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
        });

    const deps = () => ({ pool, client: harness.publicClient });

    beforeEach(async () => {
        await resetDatabase(pool);
    });

    after(async () => {
        await pool.end();
    });

    async function signAll(proposal: Proposal) {
        for (const owner of owners.slice(0, 3)) {
            const signature = await owner.signTypedData(
                executeTypedData(proposal.vault, proposal.chainId, {
                    to: proposal.to,
                    value: proposal.value,
                    data: proposal.data,
                    nonce: proposal.nonce,
                    deadline: proposal.deadline,
                }),
            );
            await addSignature(deps(), proposal.id, signature);
        }
    }

    it("proposes one top-up when the hot wallet runs low, and executes it at once", async () => {
        await setUp({ hotBalance: 400n });

        const first = await proposeTopUp(deps(), { ...config(), proposalTtlSeconds: 3600 });
        assert.equal(first.action, "top_up");
        assert.equal(first.action === "top_up" && first.amount, 4_600n);

        // Waiting for owners: a second pass must not open another.
        const second = await proposeTopUp(deps(), { ...config(), proposalTtlSeconds: 3600 });
        assert.deepEqual(second, { action: "none", reason: "a top-up is already open" });

        const proposal = await getProposal(pool, first.proposalId!);
        await signAll(proposal);
        const [report] = await submitReadyProposals({ ...deps(), wallet: submitter.walletClient });

        // Sized to the fast path, so the vault pays without a timelock wait.
        assert.equal(report?.outcome.kind, "executed");
        assert.equal(await tokenBalance(hot.address), MARKS.target);
    });

    it("sizes the top-up to what the vault may send today", async () => {
        await setUp({ hotBalance: 0n, allowance: 3_000n });

        const result = await proposeTopUp(deps(), { ...config(), proposalTtlSeconds: 3600 });

        assert.equal(result.action === "top_up" && result.amount, 3_000n);
    });

    it("counts payouts already promised against the hot balance", async () => {
        // In the band on chain, but most of it is reserved for a payout.
        await setUp({ hotBalance: 6_000n });
        const user = await createUser(pool, { email: "payout@rebalance.local", xpub: TEST_XPUB });
        const accountId = BigInt(user.accountId);
        await deposit(pool, { accountId, amount: 10_000n, idempotencyKey: "rb-seed" });
        await requestWithdrawal(pool, {
            accountId,
            to: "0x000000000000000000000000000000000000bEEF",
            amount: 5_500n,
            tokenAddress: token,
            idempotencyKey: "rb-payout",
        });

        const result = await proposeTopUp(deps(), { ...config(), proposalTtlSeconds: 3600 });

        // 6,000 on chain - 5,500 promised = 500 available.
        assert.equal(result.action === "top_up" && result.amount, 4_500n);
    });

    it("refuses to top up a hot wallet the vault does not pay", async () => {
        await setUp({ hotBalance: 0n, vaultPays: privateKeyToAccount(generatePrivateKey()).address });

        await assert.rejects(
            proposeTopUp(deps(), { ...config(), proposalTtlSeconds: 3600 }),
            /refusing to propose a top-up/,
        );
        const { rows } = await pool.query("SELECT 1 FROM vault_proposals");
        assert.equal(rows.length, 0);
    });

    it("returns the excess through the withdrawal worker, outside the ledger", async () => {
        await setUp({ hotBalance: 32_000n });
        await sendEther(harness, hot.address, 10n ** 17n);
        const hotWallet = createWalletClient({ account: hot, chain: localChain, transport: http(rpcUrl) });

        const queued = await queueExcessReturn(pool, harness.publicClient, config());
        assert.equal(queued.action === "return_excess" && queued.amount, 27_000n);

        // Planned again before it has left: the in-flight return is counted.
        const again = await queueExcessReturn(pool, harness.publicClient, config());
        assert.equal(again.action, "none");

        const workerDeps = { pool, client: harness.publicClient, wallet: hotWallet };
        const workerConfig = {
            hotWalletId: HOT_WALLET_ID,
            stuckAfterMs: 60_000,
            feeBumpPercent: 12n,
            maxBroadcastAttempts: 3,
        };
        await runWithdrawalWorkerOnce(workerDeps, workerConfig);

        // In flight, the ledger still reconciles: a rebalance reserved nothing.
        assert.equal((await reconcile(pool)).balanced, true);

        const { rows } = await pool.query<{ transaction_hash: `0x${string}` }>(
            "SELECT transaction_hash FROM chain_withdrawals WHERE id = $1",
            [queued.withdrawalId],
        );
        await harness.publicClient.waitForTransactionReceipt({ hash: rows[0]!.transaction_hash });
        const settled = await runWithdrawalWorkerOnce(workerDeps, workerConfig);

        assert.equal(settled.confirmed, 1);
        assert.equal(await tokenBalance(hot.address), MARKS.target);
        assert.equal(await tokenBalance(vault), 1_000_000n + 27_000n);

        const ledger = await pool.query("SELECT 1 FROM transactions");
        assert.equal(ledger.rows.length, 0, "moving the platform's own tokens posts nothing");
        assert.equal((await reconcile(pool)).balanced, true);
    });

    it("gives nothing back when a return fails, because nothing was taken", async () => {
        await setUp({ hotBalance: 32_000n });
        const queued = await queueExcessReturn(pool, harness.publicClient, config());
        // As the worker leaves it once it has claimed a nonce: only a submitted
        // transfer can fail.
        await pool.query(
            "UPDATE chain_withdrawals SET status = 'SUBMITTED', nonce = 0, hot_wallet_id = $2 WHERE id = $1",
            [queued.withdrawalId, HOT_WALLET_ID],
        );

        assert.equal(await refundWithdrawal(pool, queued.withdrawalId!, "test failure"), true);

        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM chain_withdrawals WHERE id = $1",
            [queued.withdrawalId],
        );
        assert.equal(rows[0]?.status, "FAILED");
        assert.equal((await pool.query("SELECT 1 FROM transactions")).rows.length, 0);
        await assertBalanced(pool);
    });

    it("keeps payouts and rebalances apart in the schema", async () => {
        const user = await createUser(pool, { email: "schema@rebalance.local", xpub: TEST_XPUB });

        // A rebalance tied to a user, and a payout tied to nobody.
        await assert.rejects(
            pool.query(
                `INSERT INTO chain_withdrawals (kind, account_id, to_address, token_address, amount)
                 VALUES ('REBALANCE', $1, $2, $3, 1)`,
                [user.accountId, "0x000000000000000000000000000000000000bEEF", token],
            ),
            /chain_withdrawals_payout_has_account/,
        );
        await assert.rejects(
            pool.query(
                `INSERT INTO chain_withdrawals (kind, to_address, token_address, amount)
                 VALUES ('PAYOUT', $1, $2, 1)`,
                ["0x000000000000000000000000000000000000bEEF", token],
            ),
            /chain_withdrawals_payout_has_account/,
        );
    });
});
