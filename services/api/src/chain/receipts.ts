import { parseEventLogs, type Address, type TransactionReceipt } from "viem";

import { transferEvent } from "./erc20.ts";

/**
 * Confirms a mined transaction actually moved the tokens it was supposed to.
 *
 * A successful receipt proves nothing on its own. A call to an address holding
 * no code succeeds trivially -- there is no code to revert -- so a wrong token
 * address yields a perfectly healthy receipt with an empty log list while
 * nothing happened at all. Both the payout worker and the sweeper check this,
 * because both would otherwise record a movement the chain never made.
 */
export function receiptMovedTokens(
    receipt: TransactionReceipt,
    expected: { token: string; to: string; amount: bigint },
): boolean {
    const transfers = parseEventLogs({
        abi: [transferEvent],
        logs: receipt.logs,
        eventName: "Transfer",
    });

    return transfers.some(
        (log) =>
            log.address.toLowerCase() === expected.token.toLowerCase() &&
            log.args.to.toLowerCase() === expected.to.toLowerCase() &&
            log.args.value === expected.amount,
    );
}

export type { Address };
