import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { localChain } from "@wallet/shared";
import { createWalletClient, http, type Address, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

import { createChainClient } from "../chain/client.ts";

/**
 * anvil's first account. This key is printed in anvil's own banner and is
 * public knowledge; it exists only on a devnet and controls nothing.
 */
const ANVIL_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const ARTIFACT_DIR = fileURLToPath(new URL("../../../../contracts/out/", import.meta.url));

interface Artifact {
    abi: readonly unknown[];
    bytecode: { object: `0x${string}` };
}

/**
 * Loads a contract compiled by forge. The artifact directory is mounted
 * read-only into the Node containers, so the backend consumes exactly the
 * bytecode Foundry produced rather than a copy that can drift.
 */
export async function loadArtifact(name: string): Promise<Artifact> {
    const path = `${ARTIFACT_DIR}${name}.sol/${name}.json`;
    try {
        return JSON.parse(await readFile(path, "utf8")) as Artifact;
    } catch (error) {
        throw new Error(
            `Could not read artifact ${name} at ${path}. Run ./wallet test-forge first. ` +
                `(${error instanceof Error ? error.message : error})`,
        );
    }
}

export interface ChainHarness {
    publicClient: PublicClient;
    walletClient: WalletClient;
    deployer: Address;
}

export function chainHarness(rpcUrl: string): ChainHarness {
    const account = privateKeyToAccount(ANVIL_ACCOUNT_0);

    return {
        // Deliberately the same constructor production uses, so the tests
        // cannot pass against a client configured differently from the real one.
        publicClient: createChainClient(rpcUrl),
        walletClient: createWalletClient({ account, chain: localChain, transport: http(rpcUrl) }),
        deployer: account.address,
    };
}

/** Deploys a fresh MockERC20 and waits until it is mined. */
export async function deployMockUsdc(harness: ChainHarness): Promise<Address> {
    const artifact = await loadArtifact("MockERC20");

    const hash = await harness.walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: ["Mock USD Coin", "USDC", 6],
        account: harness.walletClient.account ?? null,
        chain: localChain,
    });

    const receipt = await harness.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
        throw new Error("Deployment produced no contract address");
    }

    return receipt.contractAddress;
}

const MINT_AND_TRANSFER_ABI = [
    {
        type: "function",
        name: "mint",
        inputs: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/** Mints tokens straight to an address and waits for the receipt. */
export async function mintTo(
    harness: ChainHarness,
    token: Address,
    to: Address,
    value: bigint,
): Promise<bigint> {
    const hash = await harness.walletClient.writeContract({
        address: token,
        abi: MINT_AND_TRANSFER_ABI,
        functionName: "mint",
        args: [to, value],
        account: harness.walletClient.account ?? null,
        chain: localChain,
    });

    const receipt = await harness.publicClient.waitForTransactionReceipt({ hash });
    return receipt.blockNumber;
}

/** Sends a raw JSON-RPC call, for anvil methods viem does not model. */
async function anvilRpc(harness: ChainHarness, method: string, params: unknown[]): Promise<void> {
    const request = harness.publicClient.request as unknown as (args: {
        method: string;
        params: unknown[];
    }) => Promise<unknown>;

    await request({ method, params });
}

/** Mines `count` blocks immediately, without waiting on anvil's block timer. */
export async function mineBlocks(harness: ChainHarness, count: number): Promise<void> {
    await anvilRpc(harness, "anvil_mine", [`0x${count.toString(16)}`]);
}

/**
 * Rewrites the last `depth` blocks, which is what makes reorg handling testable
 * at all. The blocks at those heights keep their numbers but receive new
 * hashes, exactly as a real reorganisation would leave them.
 */
export async function induceReorg(harness: ChainHarness, depth: number): Promise<void> {
    await anvilRpc(harness, "anvil_reorg", [depth, []]);
}

/**
 * Sends one transaction from the harness account so its on-chain nonce
 * advances. Tests that care about the transaction count must create it rather
 * than assume the devnet already has some: anvil is restarted freely, and a
 * test resting on ambient chain state passes or fails by accident.
 */
export async function bumpChainNonce(harness: ChainHarness): Promise<bigint> {
    const account = harness.walletClient.account;
    if (account === undefined) throw new Error("harness wallet has no account");

    const hash = await harness.walletClient.sendTransaction({
        account,
        chain: localChain,
        to: account.address,
        value: 0n,
    });

    await harness.publicClient.waitForTransactionReceipt({ hash });
    return BigInt(
        await harness.publicClient.getTransactionCount({
            address: account.address,
            blockTag: "pending",
        }),
    );
}

/** The public Foundry test mnemonic; every key it derives is worthless. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export interface Signer {
    walletClient: WalletClient;
    address: Address;
}

/**
 * A signing client for one of anvil's accounts.
 *
 * Tests use an index well away from 0, because index 0 is both the deployer and
 * the first derived deposit address -- having the hot wallet share it would
 * make the test's own transfers look like deposits.
 */
export function anvilSigner(rpcUrl: string, addressIndex: number): Signer {
    const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex });

    return {
        walletClient: createWalletClient({ account, chain: localChain, transport: http(rpcUrl) }),
        address: account.address,
    };
}

/**
 * Turns anvil's timed mining on or off.
 *
 * Passing 0 leaves transactions sitting in the mempool, which is the only way
 * to observe a stuck transaction on a devnet that otherwise mines every two
 * seconds. Callers must restore it, or every later test hangs.
 */
export async function setIntervalMining(harness: ChainHarness, seconds: number): Promise<void> {
    await anvilRpc(harness, "evm_setIntervalMining", [seconds]);
}

/** Mints tokens to the signer that will pay them out. */
export async function fundSigner(
    harness: ChainHarness,
    token: Address,
    signer: Signer,
    amount: bigint,
): Promise<void> {
    await mintTo(harness, token, signer.address, amount);
}
