import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import {
    createWalletClient,
    encodeFunctionData,
    http,
    parseAbi,
    type Address,
    type Hex,
    type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, entryPoint08Address, type BundlerClient } from "viem/account-abstraction";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import {
    advanceChainTime,
    chainHarness,
    loadArtifact,
    sendEther,
    type ChainHarness,
} from "../test-support/chain.ts";
import { resetDatabase } from "../test-support/db.ts";
import { guardianModuleAbi, recoverableAccountAbi } from "./recovery/abi.ts";
import { runRecoveryRelayOnce } from "./recovery/relayer.ts";
import { toWalletSmartAccount } from "./smart-account.ts";

const ONE_ETHER = 10n ** 18n;
const DELAY = 48 * 3600;
const WINDOW = 7 * 24 * 3600;

const accountAdminAbi = parseAbi([
    "function setRecoveryModule(address module)",
    "function setGuardians(address[] guardians, uint256 threshold)",
    "function cancelRecovery()",
]);

describe("social recovery through the API and the relayer", () => {
    let env: Env;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp>;
    let factory: Address;
    let module: Address;
    const relayerKey = privateKeyToAccount(generatePrivateKey());

    async function deploy(name: string, args: unknown[]): Promise<Address> {
        const artifact = await loadArtifact(name);
        const hash = await harness.walletClient.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
            account: harness.walletClient.account ?? null,
            chain: localChain,
        });
        return (await harness.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    }

    before(async () => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.BUNDLER_URL === undefined) throw new Error("BUNDLER_URL is not set");
        harness = chainHarness(env.RPC_URL);
        bundler = createBundlerClient({ client: harness.publicClient, transport: http(env.BUNDLER_URL) });
        factory = await deploy("AccountFactory", [entryPoint08Address]);
        module = await deploy("GuardianModule", []);
        await sendEther(harness, relayerKey.address, ONE_ETHER);

        shared = createDeps({ ...env, GUARDIAN_MODULE_ADDRESS: module });
        app = buildApp(shared);
    });

    beforeEach(async () => {
        await resetDatabase(shared.pool);
    });

    after(async () => {
        await app.close();
        await shared.pool.end();
    });

    const relay = () =>
        runRecoveryRelayOnce({
            pool: shared.pool,
            client: harness.publicClient,
            wallet: createWalletClient({ account: relayerKey, chain: localChain, transport: http(env.RPC_URL) }),
        });

    const fresh = () => privateKeyToAccount(generatePrivateKey());

    /**
     * A deployed account whose first operation named the guardian module and
     * registered three guardians with a quorum of two.
     */
    async function recoverableAccount() {
        const owner = fresh();
        const guardians = [fresh(), fresh(), fresh()];
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, account.address, ONE_ETHER);

        const hash = await bundler.sendUserOperation({
            account,
            calls: [
                {
                    to: account.address,
                    data: encodeFunctionData({ abi: accountAdminAbi, functionName: "setRecoveryModule", args: [module] }),
                },
                {
                    to: module,
                    data: encodeFunctionData({
                        abi: accountAdminAbi,
                        functionName: "setGuardians",
                        args: [guardians.map((g) => g.address), 2n],
                    }),
                },
            ],
        });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
        return { owner, guardians, account };
    }

    const deadlineIn = async (seconds: bigint) => (await harness.publicClient.getBlock()).timestamp + seconds;

    async function openRequest(account: Address, newOwner: Address) {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/recovery/requests",
            payload: { account, newOwner, deadline: (await deadlineIn(3600n)).toString() },
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json();
    }

    /** The typed data the API hands out, integers as decimal strings. */
    type TypedJson = {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
    };

    /** What a guardian's wallet does with it. */
    function signJson(guardian: PrivateKeyAccount, typed: TypedJson) {
        const message = Object.fromEntries(
            Object.entries(typed.message).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v]),
        );
        return guardian.signTypedData({ ...typed, message } as never);
    }

    async function approve(id: string, typed: TypedJson, guardians: PrivateKeyAccount[]) {
        for (const guardian of guardians) {
            const response = await app.inject({
                method: "POST",
                url: `/api/v1/recovery/requests/${id}/approvals`,
                payload: { signature: await signJson(guardian, typed) },
            });
            assert.equal(response.statusCode, 201, response.body);
        }
    }

    const read = async (id: string) =>
        (await app.inject({ method: "GET", url: `/api/v1/recovery/requests/${id}` })).json();

    const ownerOf = (account: Address) =>
        harness.publicClient.readContract({ address: account, abi: recoverableAccountAbi, functionName: "owner" });

    it("restores a lost key: two guardians approve, and after 48 hours a new key owns the account", async () => {
        const { guardians, account } = await recoverableAccount();
        const newOwner = fresh();

        const request = await openRequest(account.address, newOwner.address);
        await approve(request.id, request.approvalTypedData, guardians.slice(0, 2));

        assert.equal((await relay())[0]?.outcome.kind, "started");
        assert.equal((await read(request.id)).status, "STARTED");

        // The delay: nothing happens however often the relayer runs.
        assert.equal((await relay())[0]?.outcome.kind, "waiting");
        assert.equal((await ownerOf(account.address)).toLowerCase(), account.owner.address.toLowerCase());

        await advanceChainTime(harness, DELAY);
        assert.equal((await relay())[0]?.outcome.kind, "executed");
        assert.equal((await ownerOf(account.address)).toLowerCase(), newOwner.address.toLowerCase());
        assert.equal((await read(request.id)).status, "EXECUTED");

        // The new key drives the same account through the bundler.
        const recovered = await toWalletSmartAccount({
            client: harness.publicClient,
            owner: newOwner,
            factory,
            address: account.address,
        });
        const hash = await bundler.sendUserOperation({ account: recovered, calls: [{ to: fresh().address, value: 1n }] });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
    });

    it("records the owner's veto, sent from the key that was never lost", async () => {
        const { guardians, account } = await recoverableAccount();
        const request = await openRequest(account.address, fresh().address);
        await approve(request.id, request.approvalTypedData, guardians.slice(1, 3));
        await relay();

        const hash = await bundler.sendUserOperation({
            account,
            calls: [{ to: module, data: encodeFunctionData({ abi: accountAdminAbi, functionName: "cancelRecovery" }) }],
        });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);

        const [report] = await relay();
        assert.deepEqual(report?.outcome, { kind: "cancelled", by: "elsewhere" });
        assert.equal((await read(request.id)).status, "CANCELLED");

        await advanceChainTime(harness, DELAY);
        assert.deepEqual(await relay(), [], "settled for good");
        assert.equal((await ownerOf(account.address)).toLowerCase(), account.owner.address.toLowerCase());
    });

    it("relays a guardian quorum withdrawing a recovery it started", async () => {
        const { guardians, account } = await recoverableAccount();
        const request = await openRequest(account.address, fresh().address);
        await approve(request.id, request.approvalTypedData, guardians.slice(0, 2));
        await relay();

        const opened = await app.inject({
            method: "POST",
            url: `/api/v1/recovery/requests/${request.id}/cancellation`,
            payload: { deadline: (await deadlineIn(3600n)).toString() },
        });
        assert.equal(opened.statusCode, 200, opened.body);
        const typed = opened.json().cancellationTypedData;
        for (const guardian of [guardians[0]!, guardians[2]!]) {
            const response = await app.inject({
                method: "POST",
                url: `/api/v1/recovery/requests/${request.id}/cancellations`,
                payload: { signature: await signJson(guardian, typed) },
            });
            assert.equal(response.statusCode, 201, response.body);
        }

        assert.deepEqual((await relay())[0]?.outcome, { kind: "cancelled", by: "guardians" });
        const [, executableAt] = await harness.publicClient.readContract({
            address: module,
            abi: guardianModuleAbi,
            functionName: "pending",
            args: [account.address],
        });
        assert.equal(executableAt, 0n);
    });

    it("starts one of two competing requests and marks the other stale", async () => {
        const { guardians, account } = await recoverableAccount();
        const first = await openRequest(account.address, fresh().address);
        const second = await openRequest(account.address, fresh().address);
        await approve(first.id, first.approvalTypedData, guardians.slice(0, 2));
        await approve(second.id, second.approvalTypedData, guardians.slice(0, 2));

        const outcomes = (await relay()).map((r) => r.outcome.kind);

        assert.deepEqual(outcomes.slice(0, 2), ["started", "stale"]);
        assert.equal((await read(second.id)).status, "STALE");
    });

    it("recognises a recovery it started but lost the receipt for", async () => {
        const { guardians, account } = await recoverableAccount();
        const newOwner = fresh();
        const request = await openRequest(account.address, newOwner.address);

        // Signed, then submitted straight to the module, as an earlier pass
        // would have before losing its receipt.
        const signatures: Hex[] = [];
        for (const guardian of guardians.slice(0, 2)) signatures.push(await signJson(guardian, request.approvalTypedData));
        for (const signature of signatures) {
            await app.inject({ method: "POST", url: `/api/v1/recovery/requests/${request.id}/approvals`, payload: { signature } });
        }
        const sorted = guardians
            .slice(0, 2)
            .map((g, i) => ({ g: g.address.toLowerCase(), s: signatures[i]! }))
            .sort((a, b) => (a.g < b.g ? -1 : 1))
            .map((x) => x.s);
        const hash = await harness.walletClient.writeContract({
            address: module,
            abi: guardianModuleAbi,
            functionName: "initiateRecovery",
            args: [account.address, newOwner.address, BigInt(request.deadline), sorted],
            account: harness.walletClient.account!,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        const [report] = await relay();
        assert.equal(report?.outcome.kind, "started", "not stale: the nonce moved because of this request");
        assert.equal((await read(request.id)).startTx, hash);
    });

    it("lets a matured recovery lapse when nobody executes it in time", async () => {
        const { guardians, account } = await recoverableAccount();
        const request = await openRequest(account.address, fresh().address);
        await approve(request.id, request.approvalTypedData, guardians.slice(0, 2));
        await relay();

        await advanceChainTime(harness, DELAY + WINDOW + 1);
        assert.equal((await relay())[0]?.outcome.kind, "lapsed");
        assert.equal((await read(request.id)).status, "LAPSED");
    });

    it("refuses what the module would refuse", async () => {
        const { guardians, account } = await recoverableAccount();
        const request = await openRequest(account.address, fresh().address);
        const post = async (signature: Hex) =>
            app.inject({ method: "POST", url: `/api/v1/recovery/requests/${request.id}/approvals`, payload: { signature } });

        const stranger = await post(await signJson(fresh(), request.approvalTypedData));
        assert.equal(stranger.statusCode, 403);
        assert.equal(stranger.json().error, "not_a_guardian");

        const signature = await signJson(guardians[0]!, request.approvalTypedData);
        await post(signature);
        assert.equal((await post(signature)).json().error, "duplicate_signature");

        const notRecoverable = await app.inject({
            method: "POST",
            url: "/api/v1/recovery/requests",
            payload: { account: fresh().address, newOwner: fresh().address, deadline: (await deadlineIn(60n)).toString() },
        });
        assert.equal(notRecoverable.statusCode, 409);
        assert.equal(notRecoverable.json().error, "not_recoverable");

        // A real smart account that never chose the module: it would reject
        // the module's call to transferOwnership, so collecting approvals for
        // it would only waste the guardians' time.
        const owner = fresh();
        const bare = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, bare.address, ONE_ETHER);
        const deployed = await bundler.sendUserOperation({ account: bare, calls: [{ to: fresh().address, value: 0n }] });
        await bundler.waitForUserOperationReceipt({ hash: deployed });
        const unchosen = await app.inject({
            method: "POST",
            url: "/api/v1/recovery/requests",
            payload: { account: bare.address, newOwner: fresh().address, deadline: (await deadlineIn(60n)).toString() },
        });
        assert.equal(unchosen.statusCode, 409);
        assert.match(unchosen.json().message, /has not chosen this guardian module/);

        const late = await app.inject({
            method: "POST",
            url: "/api/v1/recovery/requests",
            payload: { account: account.address, newOwner: fresh().address, deadline: "1" },
        });
        assert.equal(late.statusCode, 422);
    });
});
