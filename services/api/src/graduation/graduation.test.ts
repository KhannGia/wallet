import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import { encodeFunctionData, http, parseAbi, type Address, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, entryPoint08Address, type BundlerClient } from "viem/account-abstraction";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { accountFactoryAbi, toWalletSmartAccount } from "../aa/smart-account.ts";
import { getAccount, transfer } from "../ledger/operations.ts";
import { chainHarness, deployMockUsdc, loadArtifact, sendEther, type ChainHarness } from "../test-support/chain.ts";
import { assertBalanced, resetDatabase, seedAccount } from "../test-support/db.ts";

const ONE_ETHER = 10n ** 18n;

const ownershipAbi = parseAbi(["function transferOwnership(address newOwner)"]);

describe("graduation: opening, activation and funding", () => {
    let env: Env;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp>;
    let factory: Address;
    let token: Address;

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

        shared = createDeps({ ...env, ACCOUNT_FACTORY_ADDRESS: factory, USDC_ADDRESS: token });
        app = buildApp(shared);
    });

    beforeEach(async () => {
        await resetDatabase(shared.pool);
    });

    after(async () => {
        await app.close();
        await shared.pool.end();
    });

    const fresh = () => privateKeyToAccount(generatePrivateKey());

    const open = (accountId: bigint | string, owner: Address) =>
        app.inject({ method: "POST", url: `/api/v1/accounts/${accountId}/graduation`, payload: { owner } });
    const fund = (id: string) => app.inject({ method: "POST", url: `/api/v1/graduations/${id}/funding` });
    const cancel = (id: string) => app.inject({ method: "POST", url: `/api/v1/graduations/${id}/cancellation` });
    const read = async (id: string) => (await app.inject({ method: "GET", url: `/api/v1/graduations/${id}` })).json();

    /** What the user's wallet does between opening and funding: deploy the account with its own key. */
    async function activate(owner: PrivateKeyAccount) {
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, account.address, ONE_ETHER);
        const hash = await bundler.sendUserOperation({ account, calls: [{ to: owner.address, value: 0n }] });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
        return account;
    }

    async function opened(balance: bigint) {
        const accountId = await seedAccount(shared.pool, `${generatePrivateKey().slice(2, 12)}@graduation.local`, balance);
        const owner = fresh();
        const response = await open(accountId, owner.address);
        assert.equal(response.statusCode, 201, response.body);
        return { accountId, owner, graduation: response.json() };
    }

    async function reservations(accountId: bigint) {
        const { rows } = await shared.pool.query<{ kind: string; to_address: string; amount: bigint }>(
            "SELECT kind, to_address, amount FROM chain_withdrawals WHERE account_id = $1",
            [accountId],
        );
        return rows;
    }

    it("opens at the address the factory derives from the user's key, and registers it for sponsorship", async () => {
        const { owner, graduation } = await opened(5_000_000n);

        const expected = await harness.publicClient.readContract({
            address: factory,
            abi: accountFactoryAbi,
            functionName: "getAddress",
            args: [owner.address, 0n],
        });
        assert.equal(graduation.smartAccount, expected);
        assert.equal(graduation.owner, owner.address);
        assert.equal(graduation.factory, factory);
        assert.equal(graduation.salt, "0");
        assert.equal(graduation.status, "AWAITING_ACTIVATION");
        assert.equal(graduation.amount, null);

        const { rows } = await shared.pool.query("SELECT owner FROM smart_accounts WHERE address = $1", [
            expected.toLowerCase(),
        ]);
        assert.equal(rows[0]?.owner, owner.address.toLowerCase());
    });

    it("answers a repeated request with the graduation already open, and refuses a second key", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);

        const again = await open(accountId, owner.address);
        assert.equal(again.statusCode, 200, again.body);
        assert.equal(again.json().id, graduation.id);

        const other = await open(accountId, fresh().address);
        assert.equal(other.statusCode, 409, other.body);
        assert.equal(other.json().error, "graduation_in_progress");

        // Cancelled, the account is free to graduate to another key.
        assert.equal((await cancel(graduation.id)).statusCode, 200);
        assert.equal((await open(accountId, fresh().address)).statusCode, 201);
    });

    it("refuses an empty account, a system account, a missing one and a zero owner", async () => {
        const empty = await seedAccount(shared.pool, "empty@graduation.local", 0n);
        const response = await open(empty, fresh().address);
        assert.equal(response.statusCode, 422, response.body);
        assert.equal(response.json().error, "nothing_to_graduate");

        // Account 1 is BANK_GATEWAY, seeded by resetDatabase.
        assert.equal((await open(1n, fresh().address)).statusCode, 404);
        assert.equal((await open(999_999n, fresh().address)).statusCode, 404);

        const funded = await seedAccount(shared.pool, "zero@graduation.local", 1n);
        assert.equal((await open(funded, "0x0000000000000000000000000000000000000000")).statusCode, 400);
    });

    it("moves nothing until the account is deployed", async () => {
        const { accountId, graduation } = await opened(5_000_000n);

        const response = await fund(graduation.id);
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error, "not_activated");

        assert.equal((await getAccount(shared.pool, accountId)).balance, "5000000");
        assert.deepEqual(await reservations(accountId), []);
        assert.equal((await read(graduation.id)).status, "AWAITING_ACTIVATION");
    });

    it("once activated, reserves the whole balance as a graduation payout to the account", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        await activate(owner);

        const response = await fund(graduation.id);
        assert.equal(response.statusCode, 202, response.body);
        const funded = response.json();
        assert.equal(funded.status, "FUNDING");
        assert.equal(funded.amount, "5000000");
        assert.notEqual(funded.withdrawalId, null);

        const account = await getAccount(shared.pool, accountId);
        assert.equal(account.balance, "0");
        assert.equal(account.reservedBalance, "5000000");
        assert.deepEqual(await reservations(accountId), [
            { kind: "GRADUATION", to_address: graduation.smartAccount, amount: 5_000_000n },
        ]);
        await assertBalanced(shared.pool);
    });

    it("reserves once however many times funding is asked for, even all at once", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        await activate(owner);

        const responses = await Promise.all(Array.from({ length: 5 }, () => fund(graduation.id)));
        for (const response of responses) assert.equal(response.statusCode, 202, response.body);
        assert.equal((await fund(graduation.id)).json().status, "FUNDING");

        assert.equal((await reservations(accountId)).length, 1);
        assert.equal((await getAccount(shared.pool, accountId)).reservedBalance, "5000000");
        await assertBalanced(shared.pool);
    });

    it("takes the balance at funding time, not at opening", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        const other = await seedAccount(shared.pool, "other@graduation.local", 0n);
        await transfer(shared.pool, { fromAccountId: accountId, toAccountId: other, amount: 2_000_000n, idempotencyKey: "spend" });
        await activate(owner);

        assert.equal((await fund(graduation.id)).json().amount, "3000000");
        await assertBalanced(shared.pool);
    });

    it("refuses to fund an account that no longer answers to the key it was opened for", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        const account = await activate(owner);

        // The owner hands the account to another key before funding.
        const successor = fresh();
        const hash = await bundler.sendUserOperation({
            account,
            calls: [
                {
                    to: account.address,
                    data: encodeFunctionData({ abi: ownershipAbi, functionName: "transferOwnership", args: [successor.address] }),
                },
            ],
        });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);

        const response = await fund(graduation.id);
        assert.equal(response.statusCode, 409, response.body);
        assert.match(response.json().message, new RegExp(`answers to ${successor.address}`));
        assert.deepEqual(await reservations(accountId), []);
    });

    it("refuses to fund once the balance is gone, and leaves the graduation open", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        const other = await seedAccount(shared.pool, "drain@graduation.local", 0n);
        await transfer(shared.pool, { fromAccountId: accountId, toAccountId: other, amount: 5_000_000n, idempotencyKey: "drain" });
        await activate(owner);

        const response = await fund(graduation.id);
        assert.equal(response.statusCode, 422, response.body);
        assert.equal(response.json().error, "nothing_to_graduate");
        assert.equal((await read(graduation.id)).status, "AWAITING_ACTIVATION");
        await assertBalanced(shared.pool);
    });

    it("cancels only before funding, and a cancelled graduation cannot be funded", async () => {
        const first = await opened(5_000_000n);
        const cancelled = await cancel(first.graduation.id);
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        assert.equal(cancelled.json().status, "CANCELLED");
        assert.equal((await cancel(first.graduation.id)).statusCode, 200);

        await activate(first.owner);
        const response = await fund(first.graduation.id);
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error, "graduation_not_open");

        const second = await opened(5_000_000n);
        await activate(second.owner);
        assert.equal((await fund(second.graduation.id)).statusCode, 202);
        const late = await cancel(second.graduation.id);
        assert.equal(late.statusCode, 409, late.body);
        assert.equal((await read(second.graduation.id)).status, "FUNDING");
    });

    it("does not fund a graduation cancelled while funding was checking the chain", async () => {
        const { accountId, owner, graduation } = await opened(5_000_000n);
        await activate(owner);

        // Hold the graduation's row, so funding passes its first look at the
        // status and its chain checks, then waits on the lock.
        const holder = await shared.pool.connect();
        try {
            await holder.query("BEGIN");
            await holder.query("SELECT 1 FROM graduations WHERE id = $1 FOR UPDATE", [graduation.id]);

            const funding = fund(graduation.id);
            for (;;) {
                const { rows } = await shared.pool.query(
                    `SELECT 1 FROM pg_stat_activity
                      WHERE wait_event_type = 'Lock' AND query LIKE '%FROM graduations WHERE id = $1 FOR UPDATE%'`,
                );
                if (rows.length > 0) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            // The cancellation lands in that gap.
            await holder.query("UPDATE graduations SET status = 'CANCELLED', settled_at = now() WHERE id = $1", [
                graduation.id,
            ]);
            await holder.query("COMMIT");

            const response = await funding;
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(response.json().error, "graduation_not_open");
        } finally {
            holder.release();
        }

        assert.equal((await read(graduation.id)).status, "CANCELLED");
        assert.deepEqual(await reservations(accountId), []);
        assert.equal((await getAccount(shared.pool, accountId)).balance, "5000000");
        await assertBalanced(shared.pool);
    });

    it("answers 404 for an unknown graduation, and 503 when the factory is not configured", async () => {
        assert.equal((await read("999999")).error, "graduation_not_found");

        const unconfigured = buildApp({ ...shared, env: { ...shared.env, ACCOUNT_FACTORY_ADDRESS: undefined } });
        const response = await unconfigured.inject({
            method: "POST",
            url: "/api/v1/accounts/1/graduation",
            payload: { owner: fresh().address },
        });
        assert.equal(response.statusCode, 503, response.body);
        await unconfigured.close();
    });
});
