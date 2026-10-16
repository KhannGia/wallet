import { toWalletSmartAccount } from "@wallet/shared";
import { http, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { createBundlerClient, createPaymasterClient } from "viem/account-abstraction";

import { publicClient } from "./chain.ts";

/**
 * ERC-4337 from the browser: the bundler and the platform's paymaster service,
 * both through the dev server's proxy. The owner signs in the page; nothing
 * leaves it but the signed operation.
 */
export const bundler = createBundlerClient({ client: publicClient, transport: http("/bundler") });
export const paymaster = createPaymasterClient({ transport: http("/paymaster") });

export async function smartAccount(owner: LocalAccount, factory: Address, address?: Address) {
    return toWalletSmartAccount({ client: publicClient, owner, factory, ...(address ? { address } : {}) });
}

/** Sends calls as one operation, gas paid by the paymaster, and waits until it lands. */
export async function sendSponsored(
    account: Awaited<ReturnType<typeof smartAccount>>,
    calls: { to: Address; data?: Hex; value?: bigint }[],
): Promise<Hex> {
    const hash = await bundler.sendUserOperation({ account, calls, paymaster });
    const receipt = await bundler.waitForUserOperationReceipt({ hash, pollingInterval: 1_000 });
    if (!receipt.success) throw new Error(`The operation was included but reverted (${receipt.reason ?? "no reason given"})`);
    return receipt.receipt.transactionHash;
}

export const isDeployed = async (address: Address) => (await publicClient.getCode({ address })) !== undefined;
