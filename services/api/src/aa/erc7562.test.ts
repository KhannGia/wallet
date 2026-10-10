import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    encodeFunctionData,
    erc20Abi,
    http,
    parseAbi,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, entryPoint08Address, type BundlerClient } from "viem/account-abstraction";

import { loadArtifact } from "../test-support/chain.ts";
import { toSessionAccount, toWalletSmartAccount } from "./smart-account.ts";

/**
 * ERC-7562 against a bundler that enforces it: the reference bundler, from the
 * authors of ERC-4337 and ERC-7562, in safe mode on a geth dev chain -- which has
 * the tracer safe mode needs, where anvil does not.
 *
 * Both directions are tested. SmartAccount's operations -- the owner's and a
 * session key's -- are accepted. Two accounts that each break one rule are
 * refused, which is what makes the acceptance mean anything: a "safe mode" that
 * accepted them would not be checking at all.
 */

/** anvil's first key, funded on the geth chain by geth-setup. Public devnet key. */
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ONE_ETHER = 10n ** 18n;

/**
 * Fixed gas limits. These tests are about what validation may touch, which the
 * bundler checks on eth_sendUserOperation whatever the limits; the reference
 * bundler's gas estimation is a separate concern, and fails on this chain with
 * no reason given. Generous -- granting a session writes a dozen storage slots,
 * and deploying the account takes much of the verification gas -- so a limit is
 * never the reason for a refusal.
 */
const GAS = {
    callGasLimit: 1_500_000n,
    verificationGasLimit: 4_000_000n,
    preVerificationGas: 200_000n,
} as const;

const sessionAbi = parseAbi([
    "struct Condition { uint8 param; uint8 operator; bytes32 value; }",
    "struct Permission { address target; bytes4 selector; Condition[] conditions; }",
    "struct SpendLimit { address token; uint256 limit; }",
    "function addSession(address key, uint48 validAfter, uint48 validUntil, uint256 nativeLimit, Permission[] permissions, SpendLimit[] limits)",
    "function executeUserOp((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash)",
]);

describe("ERC-7562, enforced by a bundler in safe mode", () => {
    let client: PublicClient;
    let deployer: WalletClient;
    let bundler: BundlerClient;
    let factory: Address;
    let token: Address;

    async function deploy(name: string, args: unknown[]): Promise<Address> {
        const artifact = await loadArtifact(name);
        const hash = await deployer.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
            account: deployer.account!,
            chain: deployer.chain,
        });
        return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    }

    async function fund(to: Address) {
        const hash = await deployer.sendTransaction({ to, value: ONE_ETHER, account: deployer.account!, chain: deployer.chain });
        await client.waitForTransactionReceipt({ hash });
    }

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.SAFE_RPC_URL === undefined || env.SAFE_BUNDLER_URL === undefined) {
            throw new Error("SAFE_RPC_URL and SAFE_BUNDLER_URL are not set");
        }
        const probe = createPublicClient({ transport: http(env.SAFE_RPC_URL) });
        const chain = defineChain({
            id: await probe.getChainId(),
            name: "geth-dev",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [env.SAFE_RPC_URL] } },
        });
        client = createPublicClient({ chain, transport: http(env.SAFE_RPC_URL), cacheTime: 0 }) as PublicClient;
        deployer = createWalletClient({ chain, account: privateKeyToAccount(DEPLOYER_KEY), transport: http(env.SAFE_RPC_URL) });
        bundler = createBundlerClient({ client, transport: http(env.SAFE_BUNDLER_URL) });

        factory = await deploy("AccountFactory", [entryPoint08Address]);
        const usdc = await loadArtifact("MockERC20");
        const hash = await deployer.deployContract({
            abi: usdc.abi,
            bytecode: usdc.bytecode.object,
            args: ["Mock USD Coin", "USDC", 6],
            account: deployer.account!,
            chain: deployer.chain,
        });
        token = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    });

    const fresh = () => privateKeyToAccount(generatePrivateKey());

    async function mint(to: Address, amount: bigint) {
        const hash = await deployer.writeContract({
            address: token,
            abi: parseAbi(["function mint(address to, uint256 amount)"]),
            functionName: "mint",
            args: [to, amount],
            account: deployer.account!,
            chain: deployer.chain,
        });
        await client.waitForTransactionReceipt({ hash });
    }

    it("accepts the owner's first operation, deploying the account through the factory", async () => {
        const account = await toWalletSmartAccount({ client, owner: fresh(), factory });
        await fund(account.address);
        await mint(account.address, 1_000n);

        const recipient = fresh().address;
        const hash = await bundler.sendUserOperation({
            ...GAS,
            account,
            calls: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 400n] }) }],
        });

        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
        assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] }), 400n);
    });

    it("accepts a session key's operation, argument rules and cap included", async () => {
        const owner = fresh();
        const session = fresh();
        const account = await toWalletSmartAccount({ client, owner, factory });
        await fund(account.address);
        await mint(account.address, 1_000n);
        const now = (await client.getBlock()).timestamp;

        // The owner grants: transfer only, at most 300 a time, 500 in total.
        const grant = await bundler.sendUserOperation({
            ...GAS,
            account,
            calls: [
                {
                    to: account.address,
                    data: encodeFunctionData({
                        abi: sessionAbi,
                        functionName: "addSession",
                        args: [
                            session.address,
                            0,
                            Number(now + 86_400n),
                            0n,
                            [
                                {
                                    target: token,
                                    selector: "0xa9059cbb",
                                    conditions: [{ param: 1, operator: 1, value: `0x${(300n).toString(16).padStart(64, "0")}` as Hex }],
                                },
                            ],
                            [{ token, limit: 500n }],
                        ],
                    }),
                },
            ],
        });
        const granted = await bundler.waitForUserOperationReceipt({ hash: grant });
        assert.equal(granted.success, true, `granting the session reverted: ${granted.reason ?? "no reason"}`);

        // The app holds only the session key. Its operations go through
        // executeUserOp, on the session's own nonce sequence, signed with the
        // session's address in front.
        const asSession = await toSessionAccount({ client, sessionKey: session, account: account.address, factory });
        const recipient = fresh().address;
        const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 250n] });

        const hash = await bundler.sendUserOperation({ ...GAS, account: asSession, calls: [{ to: token, data: transfer }] });
        const spent = await bundler.waitForUserOperationReceipt({ hash });

        assert.equal(spent.success, true, `the session's transfer reverted: ${spent.reason ?? "no reason"}`);
        assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] }), 250n);
    });

    async function violator(name: string, extraArgs: unknown[]) {
        const owner = fresh();
        const artifact = await loadArtifact(name, "Erc7562Violators");
        const hash = await deployer.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [entryPoint08Address, owner.address, ...extraArgs],
            account: deployer.account!,
            chain: deployer.chain,
        });
        const address = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
        await fund(address);
        return toWalletSmartAccount({ client, owner, factory, address });
    }

    it("refuses an account that reads the clock while validating", async () => {
        const account = await violator("ClockReadingAccount", []);
        await assert.rejects(
            bundler.sendUserOperation({ ...GAS, account, calls: [{ to: fresh().address, value: 1n }] }),
            (error: Error) => {
                // OP-011: TIMESTAMP is among the opcodes validation may not use.
                assert.match(error.message + String((error as { details?: string }).details), /banned opcode: TIMESTAMP/);
                return true;
            },
        );
    });

    it("refuses an account that reads storage not associated with it", async () => {
        const account = await violator("ForeignStorageAccount", [token]);
        await assert.rejects(
            bundler.sendUserOperation({ ...GAS, account, calls: [{ to: fresh().address, value: 1n }] }),
            (error: Error) => {
                // STO-010: an unstaked account may read only storage associated
                // with itself; this slot holds the balance of 0xdead.
                assert.match(
                    error.message + String((error as { details?: string }).details),
                    new RegExp(`unstaked account accessed ${token} slot`, "i"),
                );
                return true;
            },
        );
    });
});
