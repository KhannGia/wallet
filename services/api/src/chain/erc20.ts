import { parseAbiItem } from "viem";

/**
 * The ERC-20 Transfer event.
 *
 * Declared here rather than read from a compiled artifact on purpose: the
 * production target is real USDC, which this project only ever watches and
 * never deploys, so there is no artifact for it. The event signature is fixed
 * by the standard.
 */
export const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
);
