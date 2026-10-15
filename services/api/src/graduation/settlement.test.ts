import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import { erc20Abi, http, type Address, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, entryPoint08Address, type BundlerClient } from "viem/account-abstraction";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { toWalletSmartAccount } from "../aa/smart-account.ts";
import { registerHotWallet } from "../chain/nonce.ts";
import { runWithdrawalWorkerOnce, type WorkerConfig } from "../chain/withdrawal-worker.ts";
import { getAccount } from "../ledger/operations.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    fundSigner,
    loadArtifact,
    mineBlocks,
    sendEther,
    setIntervalMining,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { sessionFor } from "../test-support/auth.ts";
import { assertBalanced, creditForTest, resetDatabase, seedAccount } from "../test-support/db.ts";

const ONE_ETHER = 10n ** 18n;

describe("graduation: settlement through the withdrawal worker", () => {
    let env: Env;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp>;
    let factory: Address;
    let token: Address;
    // Index 8 pays; index 7 is never given any of this token, so it cannot.
    let hot: Signer;
    let broke: Signer;

    const config = (hotWalletId: string): WorkerConfig => ({
        hotWalletId,
        stuckAfterMs: 60_000,
        feeBumpPercent: 12n,
        maxBroadcastAttempts: 1,
    });

    before(async () => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.BUNDLER_URL === undefined) throw new Error("BUNDLER_URL is not set");
        harness = chainHarness(env.RPC_URL);
        bundler = createBundlerClient({ client: harness.publicClient, transport: http(env.BUNDLER_URL) });

        const artifact = await loadArtifact("AccountFactory");
        const hash = await harness.walletClient.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [entryPoint08Address],
            account: harness.walletClient.account ?? null,
            chain: localChain,
        });
        factory = (await harness.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
        token = await deployMockUsdc(harness);
        hot = anvilSigner(env.RPC_URL, 8);
        broke = anvilSigner(env.RPC_URL, 7);

        // Lets a test take the hot wallet's tokens behind the worker's back.
        // Granted here, before beforeEach registers the hot wallet's nonce.
        const approval = await hot.walletClient.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [harness.deployer, 2n ** 256n - 1n],
            account: hot.walletClient.account ?? null,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash: approval });

        shared = createDeps({ ...env, ACCOUNT_FACTORY_ADDRESS: factory, USDC_ADDRESS: token });
        app = buildApp(shared);
    });

    beforeEach(async () => {
        await resetDatabase(shared.pool);
        for (const [id, signer] of [["hot", hot], ["broke", broke]] as const) {
            const nonce = await harness.publicClient.getTransactionCount({ address: signer.address, blockTag: "pending" });
            await registerHotWallet(shared.pool, id, signer.address, BigInt(nonce));
        }
    });

    after(async () => {
        await setIntervalMining(harness, 2);
        await app.close();
        await shared.pool.end();
    });

    const fresh = () => privateKeyToAccount(generatePrivateKey());
    const balanceOf = (address: Address) =>
        harness.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    /** The signed-in owner behind each graduation, so it can be read back. */
    const owners = new Map<string, { authorization: string }>();
    const read = async (id: string) =>
        (await app.inject({ method: "GET", url: `/api/v1/graduations/${id}`, headers: owners.get(id)! })).json();
    const work = (hotWalletId = "hot") =>
        runWithdrawalWorkerOnce(
            { pool: shared.pool, client: harness.publicClient, wallet: (hotWalletId === "hot" ? hot : broke).walletClient },
            config(hotWalletId),
        );
    const nextBlock = () => new Promise((resolve) => setTimeout(resolve, 3000));

    async function activate(owner: PrivateKeyAccount) {
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, account.address, ONE_ETHER);
        const hash = await bundler.sendUserOperation({ account, calls: [{ to: owner.address, value: 0n }] });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
    }

    /** Opened, activated and funded: the whole balance is reserved and queued for the worker. */
    async function funded(balance: bigint, owner = fresh(), accountId?: bigint) {
        accountId ??= await seedAccount(shared.pool, `${generatePrivateKey().slice(2, 12)}@settle.local`, balance);
        const headers = await sessionFor(shared.pool, accountId);
        const opened = await app.inject({
            method: "POST",
            url: `/api/v1/accounts/${accountId}/graduation`,
            headers,
            payload: { owner: owner.address },
        });
        assert.equal(opened.statusCode, 201, opened.body);
        const graduation = opened.json();
        if ((await harness.publicClient.getCode({ address: graduation.smartAccount })) === undefined) {
            await activate(owner);
        }
        owners.set(graduation.id, headers);
        const response = await app.inject({ method: "POST", url: `/api/v1/graduations/${graduation.id}/funding`, headers });
        assert.equal(response.statusCode, 202, response.body);
        return { accountId, owner, graduation: response.json() };
    }

    it("completes once the transfer settles: the tokens sit in the user's account, the liability is gone", async () => {
        await fundSigner(harness, token, hot, 5_000_000n);
        const { accountId, graduation } = await funded(5_000_000n);
        const initial = await balanceOf(graduation.smartAccount);

        assert.equal((await work()).broadcast, 1);
        assert.equal((await read(graduation.id)).status, "FUNDING");
        await nextBlock();
        assert.equal((await work()).confirmed, 1);

        const settled = await read(graduation.id);
        assert.equal(settled.status, "COMPLETED");
        assert.equal(settled.failure, null);
        assert.equal(await balanceOf(graduation.smartAccount), initial + 5_000_000n);

        const account = await getAccount(shared.pool, accountId);
        assert.equal(account.balance, "0");
        assert.equal(account.reservedBalance, "0");
        await assertBalanced(shared.pool);
    });

    it("rolls the ledger back when the transfer reverts on chain, and lets the user try again", async () => {
        // The graduation is broadcast while the hot wallet can cover it, so it
        // passes estimation. Before it is mined, the tokens leave by another
        // door -- an allowance the hot wallet granted in setup -- in a
        // transaction paying a higher tip, which anvil orders first in the
        // block. The graduation then executes against an empty balance.
        await fundSigner(harness, token, hot, 4_000_000n);
        const { accountId, owner, graduation } = await funded(4_000_000n);

        await setIntervalMining(harness, 0);
        try {
            assert.equal((await work()).broadcast, 1);
            const fees = await harness.publicClient.estimateFeesPerGas();
            await harness.walletClient.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: "transferFrom",
                args: [hot.address, "0x000000000000000000000000000000000000bEEF", await balanceOf(hot.address)],
                account: harness.walletClient.account ?? null,
                chain: localChain,
                gas: 100_000n,
                maxFeePerGas: fees.maxFeePerGas * 10n,
                maxPriorityFeePerGas: fees.maxFeePerGas * 5n,
            });
            await mineBlocks(harness, 1);
        } finally {
            await setIntervalMining(harness, 2);
        }
        assert.equal((await work()).failed, 1);

        const failed = await read(graduation.id);
        assert.equal(failed.status, "FAILED");
        assert.equal(failed.failure, "transaction reverted on chain");
        assert.equal(await balanceOf(graduation.smartAccount), 0n);

        // Back in custody, whole.
        const account = await getAccount(shared.pool, accountId);
        assert.equal(account.balance, "4000000");
        assert.equal(account.reservedBalance, "0");
        await assertBalanced(shared.pool);

        // A failed graduation is not the open one: the same key can go again.
        const retry = await app.inject({
            method: "POST",
            url: `/api/v1/accounts/${accountId}/graduation`,
            headers: owners.get(graduation.id)!,
            payload: { owner: owner.address },
        });
        assert.equal(retry.statusCode, 201, retry.body);
        assert.notEqual(retry.json().id, graduation.id);
    });

    it("refunds a graduation the worker gives up broadcasting", async () => {
        const { accountId, graduation } = await funded(3_000_000n);

        // A hot wallet with none of the token: every send fails before it
        // reaches the chain, and one failure is all this worker allows.
        assert.equal((await work("broke")).abandoned, 1);

        const failed = await read(graduation.id);
        assert.equal(failed.status, "FAILED");
        assert.match(failed.failure, /^broadcast failed: /);
        assert.equal((await getAccount(shared.pool, accountId)).balance, "3000000");
        await assertBalanced(shared.pool);
    });

    it("graduates later deposits to the same account, which needs no second activation", async () => {
        await fundSigner(harness, token, hot, 3_000_000n);
        const first = await funded(1_000_000n);
        await work();
        await nextBlock();
        await work();
        assert.equal((await read(first.graduation.id)).status, "COMPLETED");

        // Custody stays open after graduating: a deposit lands, and goes too.
        await creditForTest(shared.pool, { accountId: first.accountId, amount: 2_000_000n, idempotencyKey: "later" });
        const second = await funded(0n, first.owner, first.accountId);
        assert.equal(second.graduation.smartAccount, first.graduation.smartAccount);
        assert.equal(second.graduation.amount, "2000000");

        await work();
        await nextBlock();
        await work();
        assert.equal((await read(second.graduation.id)).status, "COMPLETED");
        assert.equal(await balanceOf(first.graduation.smartAccount), 3_000_000n);
        await assertBalanced(shared.pool);
    });
});
