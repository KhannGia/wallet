import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { localChain } from "@wallet/shared";
import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
        publicClient: createPublicClient({ chain: localChain, transport: http(rpcUrl) }),
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
