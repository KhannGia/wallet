// Entry point for the demo stack's bootstrap, run by `./wallet demo up`.
//
// Deploys every contract onto a fresh devnet, gives every worker a key of its
// own, funds those keys with ether, and writes the configuration the demo's
// services start with to .env.demo. Devnet only: the deployer is anvil's first
// account, whose key anvil prints in its own banner.
//
// The keys it generates are throwaway devnet keys, but they are still keys:
// they go to .env.demo, which git ignores, and are never printed.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { generateWallet, localChain } from "@wallet/shared";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    parseEther,
    type Abi,
    type Address,
    type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { entryPoint08Address } from "viem/account-abstraction";

const RPC_URL = process.env.RPC_URL ?? "http://anvil:8545";
const OUT = new URL("../../../../.env.demo", import.meta.url);
const ARTIFACTS = new URL("../../../../contracts/out/", import.meta.url);

/** anvil's first account. Public: it is in anvil's banner. */
const DEPLOYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** The well-known test mnemonic: vault owners anyone can sign as, in a demo. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

const USDC = 10n ** 6n;

const client = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: localChain, transport: http(RPC_URL) });

async function artifact(name: string): Promise<{ abi: Abi; bytecode: Hex }> {
    const json = JSON.parse(await readFile(new URL(`${name}.sol/${name}.json`, ARTIFACTS), "utf8"));
    return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = await artifact(name);
    const hash = await deployer.deployContract({ abi, bytecode, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment produced no address`);
    return receipt.contractAddress;
}

async function fund(to: Address, value: bigint): Promise<void> {
    await client.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to, value }) });
}

if ((await client.getCode({ address: entryPoint08Address })) === undefined) {
    throw new Error(`No EntryPoint at ${entryPoint08Address}: the entrypoint-setup service must run first.`);
}

// One key per signing role, as assertDistinctSigners insists.
const keys = {
    HOT_WALLET_PRIVATE_KEY: generatePrivateKey(),
    GAS_FUNDER_PRIVATE_KEY: generatePrivateKey(),
    VAULT_SUBMITTER_PRIVATE_KEY: generatePrivateKey(),
    PAYMASTER_SIGNER_PRIVATE_KEY: generatePrivateKey(),
    RECOVERY_RELAYER_PRIVATE_KEY: generatePrivateKey(),
    RESERVES_PUBLISHER_PRIVATE_KEY: generatePrivateKey(),
};
const address = (key: Hex) => privateKeyToAccount(key).address;
const hot = address(keys.HOT_WALLET_PRIVATE_KEY);

const token = await deploy("MockERC20", ["Mock USD Coin", "USDC", 6]);
const factory = await deploy("AccountFactory", [entryPoint08Address]);
const guardianModule = await deploy("GuardianModule", []);
const paymaster = await deploy("VerifyingPaymaster", [
    entryPoint08Address,
    address(keys.PAYMASTER_SIGNER_PRIVATE_KEY),
    deployer.account.address,
]);
const registry = await deploy("ReservesRegistry", [address(keys.RESERVES_PUBLISHER_PRIVATE_KEY), token]);

// Owners are anvil's accounts 1 to 3, two of three to approve. Anything but a
// top-up of the hot wallet of up to 1,000 USDC waits two minutes, during which
// any owner can cancel it.
const owners = [1, 2, 3]
    .map((addressIndex) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex }).address)
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
const vault = await deploy("MultisigVault", [
    owners,
    2n,
    { delay: 120n, hotWallet: hot, assets: [token], limits: [1_000n * USDC] },
]);

const paymasterAbi = parseAbi(["function deposit() payable", "function addStake(uint32 unstakeDelaySec) payable"]);
await client.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: paymaster, abi: paymasterAbi, functionName: "deposit", value: parseEther("10") }),
});
await client.waitForTransactionReceipt({
    hash: await deployer.writeContract({
        address: paymaster,
        abi: paymasterAbi,
        functionName: "addStake",
        args: [86_400],
        value: parseEther("1"),
    }),
});

// The platform's own reserves in the vault: a surplus proof of reserves shows.
await client.waitForTransactionReceipt({
    hash: await deployer.writeContract({
        address: token,
        abi: parseAbi(["function mint(address to, uint256 value)"]),
        functionName: "mint",
        args: [vault, 100_000n * USDC],
    }),
});

for (const key of Object.values(keys)) await fund(address(key), parseEther("10"));

const wallet = generateWallet();
const values: Record<string, string> = {
    ...keys,
    WALLET_MNEMONIC: wallet.mnemonic,
    WALLET_XPUB: wallet.xpub,
    API_ADMIN_TOKEN: randomBytes(32).toString("hex"),
    USDC_ADDRESS: token,
    ACCOUNT_FACTORY_ADDRESS: factory,
    GUARDIAN_MODULE_ADDRESS: guardianModule,
    PAYMASTER_ADDRESS: paymaster,
    RESERVES_REGISTRY_ADDRESS: registry,
    VAULT_ADDRESS: vault,
};

await writeFile(
    OUT,
    [
        "# Written by ./wallet demo up for the demo stack's own devnet. Throwaway keys;",
        "# never use them anywhere else. Regenerated on every run.",
        ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
        "",
    ].join("\n"),
    { mode: 0o600 },
);

console.log(
    [
        "demo contracts deployed",
        `  USDC                ${token}`,
        `  AccountFactory      ${factory}`,
        `  VerifyingPaymaster  ${paymaster}`,
        `  GuardianModule      ${guardianModule}`,
        `  ReservesRegistry    ${registry}`,
        `  MultisigVault       ${vault} (owners: anvil accounts 1-3, 2 of 3)`,
        "configuration written to .env.demo",
    ].join("\n"),
);
