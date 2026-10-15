import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import {
    custom,
    encodeFunctionData,
    erc20Abi,
    http,
    parseAbi,
    type Address,
    type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createBundlerClient,
    createPaymasterClient,
    entryPoint08Address,
    type BundlerClient,
    type PaymasterClient,
} from "viem/account-abstraction";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { buildPaymasterServer } from "../aa/paymaster/server.ts";
import { createSponsor } from "../aa/paymaster/sponsor.ts";
import { guardianModuleAbi, recoverableAccountAbi } from "../aa/recovery/abi.ts";
import { smartAccountAbi, toWalletSmartAccount } from "../aa/smart-account.ts";
import { registerHotWallet } from "../chain/nonce.ts";
import { runWithdrawalWorkerOnce } from "../chain/withdrawal-worker.ts";
import { getAccount } from "../ledger/operations.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    fundSigner,
    loadArtifact,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { sessionFor } from "../test-support/auth.ts";
import { assertBalanced, resetDatabase, seedAccount } from "../test-support/db.ts";

const setupAbi = parseAbi([
    "function setRecoveryModule(address module)",
    "function setGuardians(address[] guardians, uint256 threshold)",
    "function transferOwnership(address newOwner)",
]);

/** So a refusal is read as the contract's own reason, not any revert at all. */
const refusalAbi = parseAbi([
    "error OnlyEntryPoint()",
    "error OnlyOwnerOrRecovery()",
    "error SignatureCountMismatch(uint256 provided, uint256 required)",
]);

describe("graduation: from custody to an account only the user controls", () => {
    let env: Env;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp>;
    let paymasterClient: PaymasterClient;
    let factory: Address;
    let paymaster: Address;
    let module: Address;
    let token: Address;
    let hot: Signer;
    const paymasterSigner = privateKeyToAccount(generatePrivateKey());

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
        paymaster = await deploy("VerifyingPaymaster", [
            entryPoint08Address,
            paymasterSigner.address,
            harness.deployer,
        ]);
        const deposit = await harness.walletClient.writeContract({
            address: paymaster,
            abi: parseAbi(["function deposit() payable"]),
            functionName: "deposit",
            value: 10n ** 18n,
            account: harness.walletClient.account!,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash: deposit });
        token = await deployMockUsdc(harness);
        hot = anvilSigner(env.RPC_URL, 8);

        shared = createDeps({ ...env, ACCOUNT_FACTORY_ADDRESS: factory, USDC_ADDRESS: token });
        app = buildApp(shared);

        // The ERC-7677 service, wired in-process through its HTTP route.
        const sponsor = buildPaymasterServer(
            createSponsor(
                { pool: shared.pool, client: harness.publicClient, signer: paymasterSigner },
                {
                    paymaster,
                    entryPoint: entryPoint08Address,
                    chainId: localChain.id,
                    factory,
                    token,
                    guardianModule: module,
                    dailyCapWei: 10n ** 17n,
                    ttlSeconds: 300,
                },
            ),
            "error",
        );
        paymasterClient = createPaymasterClient({
            transport: custom({
                async request({ method, params }) {
                    const response = await sponsor.inject({
                        method: "POST",
                        url: "/",
                        payload: { jsonrpc: "2.0", id: 1, method, params },
                    });
                    const body = response.json();
                    if (body.error) throw new Error(body.error.message);
                    return body.result;
                },
            }),
        });
    });

    beforeEach(async () => {
        await resetDatabase(shared.pool);
        const nonce = await harness.publicClient.getTransactionCount({ address: hot.address, blockTag: "pending" });
        await registerHotWallet(shared.pool, "hot", hot.address, BigInt(nonce));
    });

    after(async () => {
        await app.close();
        await shared.pool.end();
    });

    const fresh = () => privateKeyToAccount(generatePrivateKey());
    const balanceOf = (address: Address) =>
        harness.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const transfer = (to: Address, amount: bigint) => ({
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    });
    const work = () =>
        runWithdrawalWorkerOnce(
            { pool: shared.pool, client: harness.publicClient, wallet: hot.walletClient },
            { hotWalletId: "hot", stuckAfterMs: 60_000, feeBumpPercent: 12n, maxBroadcastAttempts: 3 },
        );

    /**
     * Every step a user takes, through the same doors a wallet app would use:
     * the API to open and fund, the bundler and the paymaster service to
     * activate. The user never holds ether.
     */
    async function graduate(balance: bigint) {
        await fundSigner(harness, token, hot, balance);
        const accountId = await seedAccount(shared.pool, `${generatePrivateKey().slice(2, 12)}@journey.local`, balance);
        const owner = fresh();
        const guardians = [fresh(), fresh(), fresh()];

        const headers = await sessionFor(shared.pool, accountId);
        const opened = await app.inject({
            method: "POST",
            url: `/api/v1/accounts/${accountId}/graduation`,
            headers,
            payload: { owner: owner.address },
        });
        assert.equal(opened.statusCode, 201, opened.body);
        const { id, smartAccount } = opened.json();

        // Activation: deploy, adopt the guardian module and name guardians, in
        // one operation the paymaster pays for -- before any money arrives.
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        assert.equal(account.address, smartAccount);
        const activation = await bundler.sendUserOperation({
            account,
            calls: [
                {
                    to: account.address,
                    data: encodeFunctionData({ abi: setupAbi, functionName: "setRecoveryModule", args: [module] }),
                },
                {
                    to: module,
                    data: encodeFunctionData({
                        abi: setupAbi,
                        functionName: "setGuardians",
                        args: [guardians.map((g) => g.address), 2n],
                    }),
                },
            ],
            paymaster: paymasterClient,
        });
        const receipt = await bundler.waitForUserOperationReceipt({ hash: activation });
        assert.equal(receipt.success, true);
        assert.equal(receipt.paymaster?.toLowerCase(), paymaster.toLowerCase());

        const funding = await app.inject({ method: "POST", url: `/api/v1/graduations/${id}/funding`, headers });
        assert.equal(funding.statusCode, 202, funding.body);

        // The worker sends; the next pass, a block later, settles.
        assert.equal((await work()).broadcast, 1);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.equal((await work()).confirmed, 1);

        const settled = (await app.inject({ method: "GET", url: `/api/v1/graduations/${id}`, headers })).json();
        assert.equal(settled.status, "COMPLETED");
        return { accountId, owner, guardians, account };
    }

    it("activates with no ether, sets up recovery before the money arrives, and leaves the user in control", async () => {
        const { accountId, account } = await graduate(5_000_000n);

        // Recovery was in place before the transfer settled.
        assert.equal(
            (
                await harness.publicClient.readContract({
                    address: account.address,
                    abi: recoverableAccountAbi,
                    functionName: "recoveryModule",
                })
            ).toLowerCase(),
            module.toLowerCase(),
        );
        assert.equal(
            await harness.publicClient.readContract({
                address: module,
                abi: guardianModuleAbi,
                functionName: "threshold",
                args: [account.address],
            }),
            2n,
        );

        // The balance left custody and sits in the user's own account.
        assert.equal(await balanceOf(account.address), 5_000_000n);
        assert.equal((await getAccount(shared.pool, accountId)).balance, "0");
        await assertBalanced(shared.pool);

        // The user spends it, gas still paid by the platform.
        const recipient = fresh().address;
        const spend = await bundler.sendUserOperation({
            account,
            calls: [transfer(recipient, 1_000_000n)],
            paymaster: paymasterClient,
        });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash: spend })).success, true);
        assert.equal(await balanceOf(recipient), 1_000_000n);
        assert.equal(await balanceOf(account.address), 4_000_000n);
        assert.equal(await harness.publicClient.getBalance({ address: account.address }), 0n, "never held ether");
    });

    it("gives no platform key a way to move the graduated funds", async () => {
        const { owner, account } = await graduate(5_000_000n);

        // Every key the platform holds that touches this flow: the hot wallet
        // that paid out, the paymaster's signer, the deployer that owns the
        // paymaster contract, and stand-ins for the other workers' keys.
        const platform: Record<string, LocalAccount> = {
            "hot wallet": hot.walletClient.account as LocalAccount,
            "paymaster signer": paymasterSigner,
            deployer: harness.walletClient.account as LocalAccount,
            "recovery relayer": fresh(),
        };

        for (const [role, key] of Object.entries(platform)) {
            const thief = key.address;

            // Called directly, the account answers only to the EntryPoint and itself.
            const direct = [
                {
                    abi: smartAccountAbi,
                    functionName: "execute",
                    args: [token, 0n, transfer(thief, 5_000_000n).data],
                    refusal: /OnlyEntryPoint/,
                },
                {
                    abi: smartAccountAbi,
                    functionName: "executeBatch",
                    args: [[{ target: token, value: 0n, data: transfer(thief, 5_000_000n).data }]],
                    refusal: /OnlyEntryPoint/,
                },
                { abi: setupAbi, functionName: "transferOwnership", args: [thief], refusal: /OnlyOwnerOrRecovery/ },
                { abi: setupAbi, functionName: "setRecoveryModule", args: [thief], refusal: /OnlyEntryPoint/ },
                {
                    abi: smartAccountAbi,
                    functionName: "addSession",
                    args: [thief, 0, 2 ** 40, 0n, [], []],
                    refusal: /OnlyEntryPoint/,
                },
            ] as const;
            for (const { refusal, ...call } of direct) {
                await assert.rejects(
                    harness.publicClient.simulateContract({
                        ...call,
                        abi: [...call.abi, ...refusalAbi],
                        address: account.address,
                        account: key,
                    } as never),
                    refusal,
                    `${role} must not call ${call.functionName}`,
                );
            }

            // Through the EntryPoint, signed with the platform's key. The
            // paymaster's policy sees a token transfer from a known account
            // and agrees to pay -- and the account still refuses the signature.
            const impostor = await toWalletSmartAccount({
                client: harness.publicClient,
                owner: key,
                factory,
                address: account.address,
            });
            await assert.rejects(
                bundler.sendUserOperation({
                    account: impostor,
                    calls: [transfer(thief, 5_000_000n)],
                    paymaster: paymasterClient,
                }),
                /AA24/,
                `${role} must not sign for the account`,
            );

            // Recovery is the guardians' to start, not the relayer's: with no
            // approvals the module turns it away.
            await assert.rejects(
                harness.publicClient.simulateContract({
                    address: module,
                    abi: [...guardianModuleAbi, ...refusalAbi],
                    functionName: "initiateRecovery",
                    args: [account.address, thief, 2n ** 40n, []],
                    account: key,
                }),
                /SignatureCountMismatch/,
                `${role} must not start a recovery`,
            );
        }

        assert.equal(await balanceOf(account.address), 5_000_000n);
        assert.equal(
            (
                await harness.publicClient.readContract({
                    address: account.address,
                    abi: recoverableAccountAbi,
                    functionName: "owner",
                })
            ).toLowerCase(),
            owner.address.toLowerCase(),
        );
    });
});
