import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain } from "@wallet/shared";
import {
    concat,
    custom,
    encodeFunctionData,
    erc20Abi,
    http,
    numberToHex,
    pad,
    parseAbi,
    type Address,
    type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createBundlerClient,
    createPaymasterClient,
    entryPoint08Address,
    type BundlerClient,
} from "viem/account-abstraction";

import type { Pool } from "../db/pool.ts";
import {
    chainHarness,
    deployMockUsdc,
    loadArtifact,
    mintTo,
    type ChainHarness,
} from "../test-support/chain.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { checkCalls } from "./paymaster/policy.ts";
import { buildPaymasterServer } from "./paymaster/server.ts";
import {
    createSponsor,
    PAYMASTER_VERIFICATION_GAS,
    registerSmartAccount,
    type SponsorConfig,
} from "./paymaster/sponsor.ts";
import { sponsorshipDigest } from "./paymaster/sponsorship.ts";
import { smartAccountAbi, toWalletSmartAccount } from "./smart-account.ts";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;

const transferData = (to: Address, amount: bigint): Hex =>
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
const execute = (target: Address, value: bigint, data: Hex): Hex =>
    encodeFunctionData({ abi: smartAccountAbi, functionName: "execute", args: [target, value, data] });

describe("sponsorship policy", () => {
    const someone = "0x000000000000000000000000000000000000bEEF" as Address;

    it("sponsors token transfers, alone or batched", () => {
        assert.deepEqual(checkCalls(execute(TOKEN, 0n, transferData(someone, 1n)), TOKEN), { allowed: true });

        const batch = encodeFunctionData({
            abi: smartAccountAbi,
            functionName: "executeBatch",
            args: [[1n, 2n].map((amount) => ({ target: TOKEN, value: 0n, data: transferData(someone, amount) }))],
        });
        assert.deepEqual(checkCalls(batch, TOKEN), { allowed: true });
    });

    it("refuses everything else", () => {
        const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [someone, 10n ** 30n] });
        const cases: Record<string, Hex> = {
            // approve would hand the tokens to someone else at the platform's expense.
            approve: execute(TOKEN, 0n, approve),
            "another token": execute(someone, 0n, transferData(someone, 1n)),
            "ether attached": execute(TOKEN, 1n, transferData(someone, 1n)),
            "plain ether": execute(someone, 1n, "0x"),
            "trailing bytes": execute(TOKEN, 0n, concat([transferData(someone, 1n), "0x00"])),
            "not an account call": transferData(someone, 1n),
            "empty batch": encodeFunctionData({ abi: smartAccountAbi, functionName: "executeBatch", args: [[]] }),
        };
        for (const [name, callData] of Object.entries(cases)) {
            assert.equal(checkCalls(callData, TOKEN).allowed, false, `${name} must not be sponsored`);
        }
    });
});

describe("sponsored operations through the bundler", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let factory: Address;
    let paymaster: Address;
    let paymasterAbi: readonly unknown[];
    let token: Address;
    const signer = privateKeyToAccount(generatePrivateKey());
    let config: SponsorConfig;

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
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.BUNDLER_URL === undefined) throw new Error("BUNDLER_URL is not set");
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        bundler = createBundlerClient({ client: harness.publicClient, transport: http(env.BUNDLER_URL) });

        factory = await deploy("AccountFactory", [entryPoint08Address]);
        paymaster = await deploy("VerifyingPaymaster", [
            entryPoint08Address,
            signer.address,
            harness.walletClient.account!.address,
        ]);
        paymasterAbi = (await loadArtifact("VerifyingPaymaster")).abi;
        const funded = await harness.walletClient.writeContract({
            address: paymaster,
            abi: parseAbi(["function deposit() payable"]),
            functionName: "deposit",
            value: 10n ** 18n,
            account: harness.walletClient.account!,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash: funded });
        token = await deployMockUsdc(harness);

        config = {
            paymaster,
            entryPoint: entryPoint08Address,
            chainId: localChain.id,
            factory,
            token,
            dailyCapWei: 10n ** 17n,
            ttlSeconds: 300,
        };
    });

    beforeEach(async () => {
        await resetDatabase(pool);
    });

    after(async () => {
        await pool.end();
    });

    /** A paymaster client wired straight to the ERC-7677 server, through its HTTP route. */
    function paymasterClientFor(cfg: SponsorConfig) {
        const app = buildPaymasterServer(createSponsor({ pool, client: harness.publicClient, signer }, cfg), "error");
        return createPaymasterClient({
            transport: custom({
                async request({ method, params }) {
                    const response = await app.inject({
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
    }

    async function freshAccount(options: { register: boolean }) {
        const owner = privateKeyToAccount(generatePrivateKey());
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await mintTo(harness, token, account.address, 1_000_000n);
        if (options.register) await registerSmartAccount(pool, { address: account.address, owner: owner.address });
        return account;
    }

    const freshAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;
    const transfer = (to: Address, amount: bigint) => ({ to: token, data: transferData(to, amount) });

    it("signs exactly the digest the paymaster verifies", async () => {
        const op = {
            sender: freshAddress(),
            nonce: 7n,
            factory,
            factoryData: "0x1234" as Hex,
            callData: "0xabcd" as Hex,
            callGasLimit: 100_000n,
            verificationGasLimit: 200_000n,
            preVerificationGas: 50_000n,
            maxFeePerGas: 3_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
            paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
            paymasterPostOpGasLimit: 0n,
        };
        const word = (high: bigint, low: bigint) => pad(numberToHex((high << 128n) | low), { size: 32 });

        const onChain = await harness.publicClient.readContract({
            address: paymaster,
            abi: paymasterAbi,
            functionName: "hashSponsorship",
            args: [
                {
                    sender: op.sender,
                    nonce: op.nonce,
                    initCode: concat([op.factory, op.factoryData]),
                    callData: op.callData,
                    accountGasLimits: word(op.verificationGasLimit, op.callGasLimit),
                    preVerificationGas: op.preVerificationGas,
                    gasFees: word(op.maxPriorityFeePerGas, op.maxFeePerGas),
                    paymasterAndData: concat([paymaster, word(op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit)]),
                    signature: "0x",
                },
                1_900_000_000,
                0,
            ],
        });

        assert.equal(
            sponsorshipDigest({ op, paymaster, chainId: localChain.id, validUntil: 1_900_000_000, validAfter: 0 }),
            onChain,
        );
    });

    it("lets an account with no ether deploy itself and pay USDC", async () => {
        const account = await freshAccount({ register: true });
        assert.equal(await harness.publicClient.getBalance({ address: account.address }), 0n);

        const recipient = freshAddress();
        const hash = await bundler.sendUserOperation({
            account,
            calls: [transfer(recipient, 250_000n)],
            paymaster: paymasterClientFor(config),
        });
        const receipt = await bundler.waitForUserOperationReceipt({ hash });

        assert.equal(receipt.success, true);
        assert.equal(receipt.paymaster?.toLowerCase(), paymaster.toLowerCase());
        assert.equal(
            await harness.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] }),
            250_000n,
        );
        assert.equal(await harness.publicClient.getBalance({ address: account.address }), 0n, "never held ether");

        const { rows } = await pool.query("SELECT 1 FROM paymaster_sponsorships WHERE sender = $1", [
            account.address.toLowerCase(),
        ]);
        assert.equal(rows.length, 1, "the promise is on record");
    });

    it("refuses an account the platform does not know", async () => {
        const account = await freshAccount({ register: false });
        await assert.rejects(
            bundler.sendUserOperation({ account, calls: [transfer(freshAddress(), 1n)], paymaster: paymasterClientFor(config) }),
            /not a registered account/,
        );
    });

    it("refuses a call the policy does not cover", async () => {
        const account = await freshAccount({ register: true });
        const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [freshAddress(), 10n ** 30n] });
        await assert.rejects(
            bundler.sendUserOperation({ account, calls: [{ to: token, data: approve }], paymaster: paymasterClientFor(config) }),
            /only transfer is sponsored/,
        );
    });

    it("stops sponsoring an account at its daily cap", async () => {
        const account = await freshAccount({ register: true });
        const first = await bundler.sendUserOperation({
            account,
            calls: [transfer(freshAddress(), 1n)],
            paymaster: paymasterClientFor(config),
        });
        await bundler.waitForUserOperationReceipt({ hash: first });

        // A cap the first operation used up entirely. (Not "one and a half
        // times the first": that one also paid for deploying the account, so
        // a second, plain transfer costs far less and would still fit.)
        const { rows } = await pool.query<{ max_cost: string }>(
            "SELECT max_cost::TEXT FROM paymaster_sponsorships WHERE sender = $1",
            [account.address.toLowerCase()],
        );
        const capped = { ...config, dailyCapWei: BigInt(rows[0]!.max_cost) };

        await assert.rejects(
            bundler.sendUserOperation({ account, calls: [transfer(freshAddress(), 1n)], paymaster: paymasterClientFor(capped) }),
            /daily gas cap reached/,
        );
    });

    it("counts a retried request for the same nonce once", async () => {
        const account = await freshAccount({ register: true });
        const sponsor = createSponsor({ pool, client: harness.publicClient, signer }, config);
        const op = {
            sender: account.address,
            nonce: numberToHex(0n),
            factory,
            factoryData: (await account.getFactoryArgs()).factoryData,
            callData: execute(token, 0n, transferData(freshAddress(), 1n)),
            callGasLimit: numberToHex(100_000n),
            verificationGasLimit: numberToHex(300_000n),
            preVerificationGas: numberToHex(60_000n),
            maxFeePerGas: numberToHex(2_000_000_000n),
            maxPriorityFeePerGas: numberToHex(1_000_000_000n),
            paymasterVerificationGasLimit: numberToHex(PAYMASTER_VERIFICATION_GAS),
            paymasterPostOpGasLimit: numberToHex(0n),
        };

        const cost = (100_000n + 300_000n + 60_000n + PAYMASTER_VERIFICATION_GAS) * 2_000_000_000n;
        // A cap with room for exactly one of these. The retry asks for the same
        // nonce, which can only ever execute once, so it must still fit.
        const exact = createSponsor({ pool, client: harness.publicClient, signer }, { ...config, dailyCapWei: cost });
        await exact.paymasterData(op, entryPoint08Address, numberToHex(localChain.id));
        await exact.paymasterData(op, entryPoint08Address, numberToHex(localChain.id));

        const { rows } = await pool.query<{ n: string; total: string }>(
            "SELECT COUNT(*)::TEXT AS n, SUM(max_cost)::TEXT AS total FROM paymaster_sponsorships",
        );
        assert.equal(rows[0]?.n, "1");
        assert.equal(rows[0]?.total, cost.toString());

        // A different nonce is a different promise, and does not fit.
        await assert.rejects(
            exact.paymasterData({ ...op, nonce: numberToHex(1n), factory: undefined, factoryData: undefined }, entryPoint08Address, numberToHex(localChain.id)),
            /daily gas cap reached/,
        );
    });

    it("refuses requests outside its terms", async () => {
        const account = await freshAccount({ register: true });
        const sponsor = createSponsor({ pool, client: harness.publicClient, signer }, config);
        const op = {
            sender: account.address,
            nonce: numberToHex(0n),
            callData: execute(token, 0n, transferData(freshAddress(), 1n)),
            callGasLimit: numberToHex(100_000n),
            verificationGasLimit: numberToHex(300_000n),
            preVerificationGas: numberToHex(60_000n),
            maxFeePerGas: numberToHex(2_000_000_000n),
            maxPriorityFeePerGas: numberToHex(1_000_000_000n),
            paymasterVerificationGasLimit: numberToHex(PAYMASTER_VERIFICATION_GAS),
            paymasterPostOpGasLimit: numberToHex(0n),
        };
        const chain = numberToHex(localChain.id);
        const ask = (overrides: Record<string, unknown>, entryPoint: string = entryPoint08Address, chainId = chain) =>
            sponsor.paymasterData({ ...op, ...overrides }, entryPoint, chainId);

        // Another factory could deploy code that does anything at our expense.
        await assert.rejects(ask({ factory: freshAddress(), factoryData: "0x" }), /factory .* is not sponsored/);
        // More validation gas than offered is a bill nobody estimated.
        await assert.rejects(
            ask({ paymasterVerificationGasLimit: numberToHex(PAYMASTER_VERIFICATION_GAS + 1n) }),
            /paymaster gas limits differ/,
        );
        await assert.rejects(ask({ paymasterPostOpGasLimit: numberToHex(1n) }), /paymaster gas limits differ/);
        await assert.rejects(ask({ maxFeePerGas: undefined }), /gas fields missing: maxFeePerGas/);
        await assert.rejects(ask({}, freshAddress()), /only EntryPoint/);
        await assert.rejects(ask({}, entryPoint08Address, numberToHex(1)), /only chain/);
        await assert.rejects(ask({ sender: "not-an-address" }), /malformed user operation/);

        const { rows } = await pool.query("SELECT 1 FROM paymaster_sponsorships");
        assert.equal(rows.length, 0, "nothing refused was promised");
    });
});
