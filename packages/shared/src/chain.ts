import { foundry } from "viem/chains";
import type { Chain } from "viem";

/**
 * The local anvil chain. Base Sepolia gets added here once the project moves
 * off the local devnet; keeping the chain definition in one place stops the
 * services from disagreeing about which network they are on.
 */
export const localChain: Chain = foundry;

/** USDC uses 6 decimals, unlike the 18 that most ERC-20 tokens use. */
export const USDC_DECIMALS = 6;

/**
 * Money is always handled as an integer in minor units. Floating point is
 * never allowed near a balance: 0.1 + 0.2 !== 0.3.
 */
export function toMinorUnits(amount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");

  if (fraction.length > decimals) {
    throw new Error(`Amount ${amount} has more precision than ${decimals} decimals allow`);
  }

  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function fromMinorUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
