import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, sumProofFromJson, verifySumProof, type Env } from "@wallet/shared";
import { erc20Abi, getAddress, type Address } from "viem";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { runIndexerOnce, USDC_SCANNER_ID } from "../chain/indexer.ts";
import { registerHotWallet } from "../chain/nonce.ts";
import { runWithdrawalWorkerOnce } from "../chain/withdrawal-worker.ts";
import { createUser } from "../ledger/operations.ts";
import { requestWithdrawal } from "../ledger/withdrawals.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    mintTo,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { adminHeaders, sessionFor, TEST_ADMIN_TOKEN } from "../test-support/auth.ts";
import { assertBalanced, resetDatabase, TEST_XPUB } from "../test-support/db.ts";
import { computeReserves, takeReservesSnapshot, type ReservesReport } from "./reserves.ts";

const VAULT = getAddress("0x00000000000000000000000000000000000fa017");
const OUTSIDE = "0x000000000000000000000000000000000000dEaD" as Address;

describe("proof of reserves: what the platform holds against what it owes", () => {
    let env: Env;
    let harness: ChainHarness;
    let shared: AppDeps;
    let hot: Signer;
    // Fresh for every test, so no balance left by an earlier one is counted.
    let token: Address;
    let startBlock: bigint;

    before(() => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        harness = chainHarness(env.RPC_URL);
        shared = createDeps(env);
        hot = anvilSigner(env.RPC_URL, 8);
    });

    beforeEach(async () => {
        await resetDatabase(shared.pool);
        token = await deployMockUsdc(harness);
        startBlock = await harness.publicClient.getBlockNumber();
        const nonce = await harness.publicClient.getTransactionCount({ address: hot.address, blockTag: "pending" });
        await registerHotWallet(shared.pool, "hot", hot.address, BigInt(nonce));
    });

    after(async () => {
        await shared.pool.end();
    });

    const deps = () => ({ pool: shared.pool, client: harness.publicClient });
    const config = () => ({ token, vault: VAULT, scannerId: USDC_SCANNER_ID });

    /** Scans to the head; deposits become final only `depth` blocks later. */
    const index = (depth = 1n) =>
        runIndexerOnce(deps(), {
            scannerId: USDC_SCANNER_ID,
            token,
            startBlock,
            finality: { kind: "confirmations", depth },
        });

    /** The report, after checking what must hold of every report. */
    async function reserves(): Promise<ReservesReport> {
        const report = await computeReserves(deps(), config());
        const sum = report.liabilities.accounts.reduce((total, account) => total + account.amount, 0n);
        assert.equal(sum, report.liabilities.total, "the accounts' shares make the total");
        for (const account of report.liabilities.accounts) {
            assert.ok(account.amount >= 0n, `account ${account.accountId} is owed a negative amount`);
        }
        assert.equal(report.surplus, report.assets.total - report.liabilities.total);
        return report;
    }

    const balanceOf = (address: Address) =>
        harness.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });

    /** Sends tokens from an address whose key the test holds, as a sweep or a rebalance would. */
    async function move(from: Signer, to: Address, amount: bigint) {
        const hash = await from.walletClient.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "transfer",
            args: [to, amount],
            account: from.walletClient.account ?? null,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });
    }

    /**
     * A user and their deposit address. Indexes from 1: index 0 of the test
     * mnemonic is the harness's own account, which deploys and mints.
     */
    async function user(email: string) {
        const created = await createUser(shared.pool, { email, xpub: TEST_XPUB });
        const derivationIndex = Number(created.derivationIndex);
        return {
            accountId: BigInt(created.accountId),
            address: created.depositAddress as Address,
            signer: anvilSigner(env.RPC_URL, derivationIndex),
        };
    }

    it("owes nothing and holds nothing before anything happens", async () => {
        const report = await reserves();
        assert.equal(report.assets.total, 0n);
        assert.equal(report.liabilities.total, 0n);
        assert.equal(report.solvent, true);
    });

    it("counts a deposit on both sides from the moment it is seen, final or not", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 7_000_000n);

        // Seen, not final: owed all the same, since it will be.
        assert.equal((await index(100n)).recorded, 1);
        let report = await reserves();
        assert.equal(report.assets.depositAddresses, 7_000_000n);
        assert.equal(report.liabilities.total, 7_000_000n);
        assert.equal(report.surplus, 0n);

        // Final: moved from pending to the balance, the total unchanged.
        assert.equal((await index(1n)).confirmed, 1);
        report = await reserves();
        assert.equal(report.liabilities.total, 7_000_000n);
        assert.equal(report.surplus, 0n);
        await assertBalanced(shared.pool);
    });

    it("is unmoved by tokens moving between the platform's own addresses", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 5_000_000n);
        await index(1n);

        // A sweep, then a rebalance: deposit address -> hot wallet -> vault.
        await move(alice.signer, hot.address, 5_000_000n);
        await move(hot, VAULT, 2_000_000n);
        await index(1n);

        const report = await reserves();
        assert.equal(report.assets.depositAddresses, 0n);
        assert.deepEqual(report.assets.hotWallets, [{ address: hot.address, balance: 3_000_000n }]);
        assert.deepEqual(report.assets.vault, { address: VAULT, balance: 2_000_000n });
        assert.equal(report.assets.total, 5_000_000n);
        assert.equal(report.surplus, 0n);
    });

    it("counts a payout as owed until it is on chain, and not after, settled or not", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 6_000_000n);
        await index(1n);
        await move(alice.signer, hot.address, 6_000_000n);

        await requestWithdrawal(shared.pool, {
            accountId: alice.accountId,
            to: OUTSIDE,
            amount: 4_000_000n,
            tokenAddress: token,
            idempotencyKey: "payout",
        });
        await index(1n);
        let report = await reserves();
        assert.equal(report.liabilities.total, 6_000_000n, "reserved is still owed");
        assert.equal(report.surplus, 0n);

        // Broadcast and mined, but the worker has not settled it yet.
        const worker = () =>
            runWithdrawalWorkerOnce(
                { pool: shared.pool, client: harness.publicClient, wallet: hot.walletClient },
                { hotWalletId: "hot", stuckAfterMs: 60_000, feeBumpPercent: 12n, maxBroadcastAttempts: 3 },
            );
        assert.equal((await worker()).broadcast, 1);
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Mined after the indexer's block: at that block the tokens were
        // still in the hot wallet, so the payout is still owed there.
        report = await reserves();
        assert.equal(report.liabilities.minedNotSettled, 0n);
        assert.equal(report.liabilities.total, 6_000_000n);
        assert.equal(report.surplus, 0n);

        await index(1n);
        report = await reserves();
        assert.equal(report.liabilities.minedNotSettled, 4_000_000n);
        assert.equal(report.liabilities.total, 2_000_000n);
        assert.equal(report.assets.total, 2_000_000n);
        assert.equal(report.surplus, 0n);

        assert.equal((await worker()).confirmed, 1);
        report = await reserves();
        assert.equal(report.liabilities.minedNotSettled, 0n);
        assert.equal(report.liabilities.total, 2_000_000n);
        assert.equal(report.surplus, 0n);
        await assertBalanced(shared.pool);
    });

    it("reads every balance at the indexer's block, so a deposit it has not reached counts on neither side", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 1_000_000n);
        await index(1n);

        // Arrives after the cursor: in the chain's balances now, but not at
        // the block the snapshot reads, and not yet in the ledger.
        await mintTo(harness, token, alice.address, 9_000_000n);
        const report = await reserves();
        assert.equal(report.assets.total, 1_000_000n);
        assert.equal(report.liabilities.total, 1_000_000n);
        assert.equal(report.surplus, 0n);
    });

    it("leaves out a deposit the indexer recorded but has not yet moved its cursor past", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 1_000_000n);
        await index(100n);
        await mintTo(harness, token, alice.address, 4_000_000n);
        await index(100n);

        // The indexer records a range's deposits before it advances the
        // cursor. Caught between the two, the second deposit is in the ledger
        // while the cursor -- the snapshot's block -- is still before it.
        await shared.pool.query(
            `UPDATE indexer_state
                SET last_scanned_block = (SELECT MAX(block_number) - 1 FROM chain_deposits)
              WHERE id = $1`,
            [USDC_SCANNER_ID],
        );
        const report = await reserves();
        assert.equal(report.assets.total, 1_000_000n);
        assert.equal(report.liabilities.total, 1_000_000n);
        assert.equal(report.surplus, 0n);
    });

    it("reports tokens nobody is owed as a surplus", async () => {
        await mintTo(harness, token, hot.address, 3_000_000n);
        await index(1n);
        const report = await reserves();
        assert.equal(report.surplus, 3_000_000n);
        assert.equal(report.solvent, true);
    });

    it("detects tokens leaving behind the ledger's back", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 5_000_000n);
        await index(1n);
        await move(alice.signer, hot.address, 5_000_000n);

        // The hot wallet's key spends outside the worker: no ledger entry.
        await move(hot, OUTSIDE, 1_500_000n);
        await index(1n);

        const report = await reserves();
        assert.equal(report.solvent, false);
        assert.equal(report.surplus, -1_500_000n);
    });

    it("counts an address that plays two roles once", async () => {
        // The ninth user's deposit address, index 8 of the test mnemonic, is
        // the hot wallet itself.
        let ninth;
        for (let i = 0; i < 9; i++) ninth = await user(`user-${i}@reserves.local`);
        assert.equal(ninth?.address, hot.address);
        await mintTo(harness, token, hot.address, 2_000_000n);
        await index(1n);

        const report = await reserves();
        assert.equal(report.assets.total, 2_000_000n);
        assert.equal(report.assets.depositAddresses, 0n, "already counted as the hot wallet");
    });

    it("records snapshots and answers 500 when the platform is short", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        await mintTo(harness, token, alice.address, 5_000_000n);
        await index(1n);

        const app = buildApp({
            ...shared,
            env: { ...shared.env, USDC_ADDRESS: token, VAULT_ADDRESS: VAULT, API_ADMIN_TOKEN: TEST_ADMIN_TOKEN },
        });
        try {
            assert.equal((await app.inject({ method: "POST", url: "/api/v1/admin/reserves" })).statusCode, 401);
            assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/reserves", headers: adminHeaders })).statusCode, 404);

            const taken = await app.inject({ method: "POST", url: "/api/v1/admin/reserves", headers: adminHeaders });
            assert.equal(taken.statusCode, 201, taken.body);
            assert.equal(taken.json().assets, "5000000");
            assert.equal(taken.json().liabilities, "5000000");
            assert.equal(taken.json().solvent, true);
            assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/reserves", headers: adminHeaders })).statusCode, 200);

            // Each account's share is recorded, and they add up.
            const { rows } = await shared.pool.query<{ total: string }>(
                "SELECT SUM(amount) AS total FROM reserve_liabilities WHERE snapshot_id = $1",
                [taken.json().id],
            );
            assert.equal(rows[0]?.total, "5000000");

            // Tokens leave the deposit address with no ledger entry.
            await move(alice.signer, OUTSIDE, 1n);
            await index(1n);
            const short = await app.inject({ method: "POST", url: "/api/v1/admin/reserves", headers: adminHeaders });
            assert.equal(short.statusCode, 500, short.body);
            assert.equal(short.json().surplus, "-1");
            assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/reserves", headers: adminHeaders })).statusCode, 500);
        } finally {
            await app.close();
        }

        const unconfigured = buildApp({
            ...shared,
            env: { ...shared.env, USDC_ADDRESS: undefined, API_ADMIN_TOKEN: TEST_ADMIN_TOKEN },
        });
        const response = await unconfigured.inject({ method: "GET", url: "/api/v1/admin/reserves", headers: adminHeaders });
        assert.equal(response.json().error, "reserves_not_configured");
        await unconfigured.close();
    });

    it("keeps each snapshot's shares with it", async () => {
        await user("skip-index-0@reserves.local");
        const alice = await user("alice@reserves.local");
        const bob = await user("bob@reserves.local");
        await mintTo(harness, token, alice.address, 1_000_000n);
        await mintTo(harness, token, bob.address, 2_000_000n);
        await index(1n);

        const snapshot = await takeReservesSnapshot(deps(), config());
        const { rows } = await shared.pool.query<{ account_id: bigint; amount: string }>(
            "SELECT account_id, amount FROM reserve_liabilities WHERE snapshot_id = $1 ORDER BY account_id",
            [snapshot.id],
        );
        assert.deepEqual(
            rows.filter((row) => row.amount !== "0").map((row) => [row.account_id, row.amount]),
            [
                [alice.accountId, "1000000"],
                [bob.accountId, "2000000"],
            ],
        );
        assert.equal(await balanceOf(alice.address), 1_000_000n);
    });

    describe("each user's proof", () => {
        let app: ReturnType<typeof buildApp>;
        beforeEach(() => {
            app = buildApp({ ...shared, env: { ...shared.env, USDC_ADDRESS: token, VAULT_ADDRESS: VAULT } });
        });
        const close = () => app.close();
        const proofOf = async (id: unknown, accountId: bigint, as: bigint = accountId) =>
            app.inject({
                method: "GET",
                url: `/api/v1/reserves/${id}/proof/${accountId}`,
                headers: await sessionFor(shared.pool, as),
            });

        it("proves every user's share into the root, whose sum is the liabilities", async () => {
            try {
                await user("skip-index-0@reserves.local");
                const alice = await user("alice@reserves.local");
                const bob = await user("bob@reserves.local");
                const carol = await user("carol@reserves.local");
                await mintTo(harness, token, alice.address, 1_000_000n);
                await mintTo(harness, token, bob.address, 2_500_000n);
                await index(1n);

                const snapshot = await takeReservesSnapshot(deps(), config());
                assert.equal(snapshot.root.sum, 3_500_000n);

                const latest = (await app.inject({ method: "GET", url: "/api/v1/reserves/latest" })).json();
                assert.equal(latest.rootHash, snapshot.root.hash);
                assert.equal(latest.liabilities, "3500000");
                assert.equal(latest.detail, undefined, "the breakdown stays with the admin endpoint");

                for (const [who, owed] of [[alice, 1_000_000n], [bob, 2_500_000n], [carol, 0n]] as const) {
                    const response = await proofOf(snapshot.id, who.accountId);
                    assert.equal(response.statusCode, 200, response.body);
                    const body = response.json();
                    assert.deepEqual(body.root, { hash: snapshot.root.hash, sum: "3500000" });

                    // What a user does with it, trusting nothing but the published root.
                    const proof = sumProofFromJson(body.proof);
                    assert.equal(proof.leaf.accountId, who.accountId);
                    assert.equal(proof.leaf.amount, owed);
                    assert.equal(verifySumProof(proof, { hash: body.root.hash, sum: BigInt(body.root.sum) }).valid, true);
                }
            } finally {
                await close();
            }
        });

        it("draws fresh salts every snapshot, so leaves cannot be linked across them", async () => {
            try {
                await user("skip-index-0@reserves.local");
                const alice = await user("alice@reserves.local");
                await mintTo(harness, token, alice.address, 1_000_000n);
                await index(1n);

                const first = await takeReservesSnapshot(deps(), config());
                const second = await takeReservesSnapshot(deps(), config());
                assert.equal(first.root.sum, second.root.sum);
                assert.notEqual(first.root.hash, second.root.hash);

                const salts = await Promise.all(
                    [first, second].map(async (snapshot) => (await proofOf(snapshot.id, alice.accountId)).json().proof.leaf.salt),
                );
                assert.notEqual(salts[0], salts[1]);
            } finally {
                await close();
            }
        });

        it("refuses unknown snapshots and accounts, old snapshots, and rows changed since", async () => {
            try {
                await user("skip-index-0@reserves.local");
                const alice = await user("alice@reserves.local");
                await mintTo(harness, token, alice.address, 1_000_000n);
                await index(1n);
                const snapshot = await takeReservesSnapshot(deps(), config());

                assert.equal((await proofOf(999_999, alice.accountId)).json().error, "reserves_snapshot_not_found");
                const late = await user("late@reserves.local");
                assert.equal((await proofOf(snapshot.id, late.accountId)).json().error, "not_in_snapshot");
                assert.equal((await proofOf("abc", alice.accountId)).statusCode, 400);
                // A proof carries its salt, so it is its owner's alone.
                assert.equal((await proofOf(snapshot.id, alice.accountId, late.accountId)).json().error, "account_not_found");

                // A snapshot from before snapshots had a tree.
                const { rows } = await shared.pool.query<{ id: bigint }>(
                    `INSERT INTO reserve_snapshots (token_address, block_number, assets, liabilities, detail)
                     VALUES ($1, 0, 0, 0, '{}') RETURNING id`,
                    [token],
                );
                assert.equal((await proofOf(rows[0]!.id, alice.accountId)).json().error, "no_tree_for_snapshot");

                // A total edited after the root was recorded, then an amount:
                // no proof is handed out for a tree that no longer matches.
                await shared.pool.query("UPDATE reserve_snapshots SET liabilities = liabilities + 1 WHERE id = $1", [
                    snapshot.id,
                ]);
                assert.equal((await proofOf(snapshot.id, alice.accountId)).statusCode, 500);
                await shared.pool.query("UPDATE reserve_snapshots SET liabilities = liabilities - 1 WHERE id = $1", [
                    snapshot.id,
                ]);
                assert.equal((await proofOf(snapshot.id, alice.accountId)).statusCode, 200);

                // A salt swapped: the total is unchanged, the tree is not.
                const [saltRow] = (
                    await shared.pool.query<{ salt: string }>(
                        "SELECT salt FROM reserve_liabilities WHERE snapshot_id = $1 AND account_id = $2",
                        [snapshot.id, alice.accountId],
                    )
                ).rows;
                await shared.pool.query(
                    "UPDATE reserve_liabilities SET salt = $3 WHERE snapshot_id = $1 AND account_id = $2",
                    [snapshot.id, alice.accountId, `0x${"ab".repeat(32)}`],
                );
                assert.equal((await proofOf(snapshot.id, alice.accountId)).statusCode, 500);
                await shared.pool.query(
                    "UPDATE reserve_liabilities SET salt = $3 WHERE snapshot_id = $1 AND account_id = $2",
                    [snapshot.id, alice.accountId, saltRow!.salt],
                );

                await shared.pool.query(
                    "UPDATE reserve_liabilities SET amount = amount + 1 WHERE snapshot_id = $1 AND account_id = $2",
                    [snapshot.id, alice.accountId],
                );
                assert.equal((await proofOf(snapshot.id, alice.accountId)).statusCode, 500);
            } finally {
                await close();
            }
        });
    });
});
