import type { PublicClient, WalletClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { LedgerError } from "../ledger/errors.ts";
import { findReadyProposals, submitProposal, type SubmissionOutcome } from "./proposals.ts";

export interface SubmissionReport {
    id: bigint;
    outcome: SubmissionOutcome | { kind: "skipped"; reason: string };
}

/**
 * One pass: submits every proposal that has reached its quorum.
 *
 * Proposals are tried one after another rather than in parallel. They usually
 * target the same vault, and each execution moves its nonce, so only the
 * first of two concurrent submissions could ever succeed.
 */
export async function submitReadyProposals(deps: {
    pool: Pool;
    client: PublicClient;
    wallet: WalletClient;
}): Promise<SubmissionReport[]> {
    const reports: SubmissionReport[] = [];

    for (const id of await findReadyProposals(deps.pool)) {
        try {
            reports.push({ id, outcome: await submitProposal(deps, id) });
        } catch (error) {
            // Stale, expired, or settled by another submitter since the query:
            // each is already recorded on the row, and none should stop the
            // proposals queued behind it. Anything else is a real fault.
            if (!(error instanceof LedgerError)) throw error;
            reports.push({ id, outcome: { kind: "skipped", reason: error.code } });
        }
    }

    return reports;
}
