import { createPublicClient, encodeFunctionData, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";

/**
 * The chain, through the dev server's /chain proxy. Reads only -- except the
 * devnet faucet below, which exists because a demo has no other way to get
 * test tokens to a deposit address.
 */
export const publicClient = createPublicClient({ chain: foundry, transport: http("/chain"), pollingInterval: 1_000 });

/** anvil's first account. anvil keeps it unlocked, so it signs without a key ever reaching the browser. */
const FAUCET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export const isDevnet = (chainId: number) => chainId === foundry.id;

/** Mints test USDC to `to` -- what a deposit from an exchange or another wallet would be. */
export async function faucet(token: Address, to: Address, amount: bigint): Promise<void> {
    const hash = await publicClient.request({
        method: "eth_sendTransaction",
        params: [
            {
                from: FAUCET,
                to: token,
                data: encodeFunctionData({
                    abi: parseAbi(["function mint(address to, uint256 value)"]),
                    functionName: "mint",
                    args: [to, amount],
                }),
            },
        ],
    } as never);
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
}
