import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain } from "@wallet/shared";
import { encodeFunctionData, erc20Abi, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createBundlerClient,
    entryPoint08Address,
    getUserOperationTypedData,
    type BundlerClient,
} from "viem/account-abstraction";

import {
    chainHarness,
    deployMockUsdc,
    loadArtifact,
    mintTo,
    sendEther,
    type ChainHarness,
} from "../test-support/chain.ts";
import { toWalletSmartAccount } from "./smart-account.ts";

const ONE_ETHER = 10n ** 18n;

describe("smart accounts through the bundler", () => {
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let factory: Address;
    let token: Address;

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.BUNDLER_URL === undefined) throw new Error("BUNDLER_URL is not set");
        harness = chainHarness(env.RPC_URL);
        bundler = createBundlerClient({
            client: harness.publicClient,
            transport: http(env.BUNDLER_URL),
        });

        // The factory is ours; the EntryPoint is the canonical v0.8 one the
        // compose stack deploys before the bundler starts.
        const artifact = await loadArtifact("AccountFactory");
        const hash = await harness.walletClient.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [entryPoint08Address],
            account: harness.walletClient.account ?? null,
            chain: localChain,
        });
        const receipt = await harness.publicClient.waitForTransactionReceipt({ hash });
        factory = receipt.contractAddress!;
        token = await deployMockUsdc(harness);
    });

    const freshOwner = () => privateKeyToAccount(generatePrivateKey());
    const freshAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

    const tokenBalance = (address: Address) =>
        harness.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
        });

    const transfer = (to: Address, amount: bigint) => ({
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    });

    it("sends the first UserOperation, deploying the account on the way", async () => {
        const owner = freshOwner();
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        const address = account.address;

        // Funds arrive at an address with nothing deployed behind it yet.
        assert.equal(await harness.publicClient.getCode({ address }), undefined);
        await sendEther(harness, address, ONE_ETHER);
        await mintTo(harness, token, address, 1_000_000n);

        const recipient = freshAddress();
        const hash = await bundler.sendUserOperation({ account, calls: [transfer(recipient, 250_000n)] });
        const receipt = await bundler.waitForUserOperationReceipt({ hash });

        assert.equal(receipt.success, true);
        assert.equal(receipt.sender.toLowerCase(), address.toLowerCase());
        assert.ok(await harness.publicClient.getCode({ address }), "deployed by its first operation");
        assert.equal(await tokenBalance(recipient), 250_000n);
        // The account paid for its own deployment and execution, in ether.
        assert.ok((await harness.publicClient.getBalance({ address })) < ONE_ETHER);
    });

    it("batches calls in later operations, with no deployment", async () => {
        const owner = freshOwner();
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, account.address, ONE_ETHER);
        await mintTo(harness, token, account.address, 1_000_000n);

        const first = await bundler.sendUserOperation({ account, calls: [transfer(freshAddress(), 1n)] });
        await bundler.waitForUserOperationReceipt({ hash: first });

        const [a, b] = [freshAddress(), freshAddress()];
        const second = await bundler.sendUserOperation({
            account,
            calls: [transfer(a, 100n), transfer(b, 200n)],
        });
        const receipt = await bundler.waitForUserOperationReceipt({ hash: second });

        assert.equal(receipt.success, true);
        // Key 0, sequence 1: the account's second operation, in order.
        assert.equal(BigInt(receipt.nonce), 1n);
        assert.equal(await tokenBalance(a), 100n);
        assert.equal(await tokenBalance(b), 200n);
    });

    it("is turned away by the bundler when someone else signs", async () => {
        const owner = freshOwner();
        const stranger = freshOwner();
        const genuine = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, genuine.address, ONE_ETHER);

        // The real account's address and initCode, but a stranger's signature.
        const forged = {
            ...genuine,
            async signUserOperation(parameters: Parameters<typeof genuine.signUserOperation>[0]) {
                const { chainId = localChain.id, ...userOperation } = parameters;
                return stranger.signTypedData(
                    getUserOperationTypedData({
                        chainId,
                        entryPointAddress: entryPoint08Address,
                        userOperation: { ...userOperation, sender: genuine.address },
                    }),
                );
            },
        };

        await assert.rejects(
            bundler.sendUserOperation({ account: forged, calls: [{ to: stranger.address, value: 1n }] }),
            /AA24/,
        );
        // Rejected before it reached the chain: nothing deployed, nothing spent.
        assert.equal(await harness.publicClient.getCode({ address: genuine.address }), undefined);
        assert.equal(await harness.publicClient.getBalance({ address: genuine.address }), ONE_ETHER);
    });
});
