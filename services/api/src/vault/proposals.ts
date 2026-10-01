import {
    getAddress,
    parseEventLogs,
    parseSignature,
    recoverAddress,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { one, withTransaction, type Pool } from "../db/pool.ts";
import { vaultAbi } from "./abi.ts";
import {
    DeadlineInPast,
    DuplicateSignature,
    InvalidSignature,
    NotAVaultOwner,
    NotEnoughSignatures,
    ProposalAlreadyOpen,
    ProposalExpired,
    ProposalNotFound,
    ProposalNotOpen,
    ProposalStale,
} from "./errors.ts";
import { executeDigest } from "./typed-data.ts";

/** Half the secp256k1 group order. A valid signature's s must not exceed it. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface Proposal {
    id: bigint;
    vault: Address;
    chainId: number;
    to: Address;
    value: bigint;
    data: Hex;
    nonce: bigint;
    deadline: bigint;
    digest: Hex;
    threshold: number;
    status: "COLLECTING" | "EXECUTED" | "STALE" | "EXPIRED";
    transactionHash: Hex | null;
    /** Why the last submission did not execute. Cleared by a retry. */
    failure: string | null;
}

interface ProposalRow {
    id: bigint;
    vault_address: string;
    chain_id: bigint;
    to_address: string;
    value: string;
    data: string;
    nonce: bigint;
    deadline: bigint;
    digest: string;
    threshold: number;
    status: Proposal["status"];
    transaction_hash: string | null;
    failure: string | null;
}

function toProposal(row: ProposalRow): Proposal {
    return {
        id: row.id,
        vault: row.vault_address as Address,
        chainId: Number(row.chain_id),
        to: row.to_address as Address,
        // NUMERIC comes back from node-postgres as a string, never as a number:
        // parsing it into a JS number would silently round anything above 2^53.
        value: BigInt(row.value),
        data: row.data as Hex,
        nonce: row.nonce,
        deadline: row.deadline,
        digest: row.digest as Hex,
        threshold: row.threshold,
        status: row.status,
        transactionHash: row.transaction_hash as Hex | null,
        failure: row.failure,
    };
}

async function loadProposal(pool: Pool, id: bigint): Promise<Proposal> {
    const { rows } = await pool.query<ProposalRow>("SELECT * FROM vault_proposals WHERE id = $1", [
        id,
    ]);
    const row = rows[0];
    if (row === undefined) throw new ProposalNotFound(id);
    return toProposal(row);
}

/**
 * Chain time, not wall-clock time. The vault compares its deadline against
 * block.timestamp, so that is the only clock whose answer matters -- and on a
 * devnet it can be far from the host's.
 */
async function chainNow(client: PublicClient): Promise<bigint> {
    return (await client.getBlock()).timestamp;
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Opens a proposal for the vault's current nonce.
 *
 * The digest is computed locally from the same EIP-712 definition the contract
 * uses, rather than fetched from it. That makes it the thing owners actually
 * sign, and a test checks it against the vault's own hashExecute so the two
 * cannot quietly disagree.
 */
export async function createProposal(
    deps: { pool: Pool; client: PublicClient },
    params: { vault: Address; to: Address; value: bigint; data: Hex; deadline: bigint },
): Promise<Proposal> {
    const { pool, client } = deps;

    const [chainId, nonce, threshold, now] = await Promise.all([
        client.getChainId(),
        client.readContract({ address: params.vault, abi: vaultAbi, functionName: "nonce" }),
        client.readContract({ address: params.vault, abi: vaultAbi, functionName: "threshold" }),
        chainNow(client),
    ]);

    if (params.deadline <= now) {
        throw new DeadlineInPast(params.deadline, now);
    }

    const digest = executeDigest(params.vault, chainId, {
        to: params.to,
        value: params.value,
        data: params.data,
        nonce,
        deadline: params.deadline,
    });

    try {
        const { rows } = await pool.query<ProposalRow>(
            `INSERT INTO vault_proposals
                 (vault_address, chain_id, to_address, value, data, nonce, deadline, digest, threshold)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                params.vault,
                chainId,
                params.to,
                params.value.toString(),
                params.data,
                nonce,
                params.deadline,
                digest,
                Number(threshold),
            ],
        );
        return toProposal(one(rows, "proposal"));
    } catch (error) {
        if (isUniqueViolation(error)) throw new ProposalAlreadyOpen(nonce);
        throw error;
    }
}

export interface SignatureReceipt {
    signer: Address;
    collected: number;
    threshold: number;
}

/**
 * Accepts one owner's signature, after checking everything the vault would.
 *
 * Every check here mirrors one the contract makes on submission. Skipping any
 * of them would not make the vault unsafe -- it would still refuse -- but it
 * would let a proposal look ready when its submission is certain to fail, and
 * nobody would find out until the quorum had already been spent on it.
 */
export async function addSignature(
    deps: { pool: Pool; client: PublicClient },
    proposalId: bigint,
    signature: Hex,
): Promise<SignatureReceipt> {
    const { pool, client } = deps;
    const proposal = await loadProposal(pool, proposalId);

    if (proposal.status !== "COLLECTING") {
        throw new ProposalNotOpen(proposal.id, proposal.status);
    }

    if ((await chainNow(client)) > proposal.deadline) {
        await pool.query(
            "UPDATE vault_proposals SET status = 'EXPIRED', settled_at = now() WHERE id = $1 AND status = 'COLLECTING'",
            [proposal.id],
        );
        throw new ProposalExpired(proposal.id);
    }

    // The vault accepts only the 65-byte encoding and only the lower half of s.
    // Anything else would recover here and revert there.
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new InvalidSignature("signature must be 65 bytes: r, s and v");
    }
    if (BigInt(parseSignature(signature).s) > HALF_N) {
        throw new InvalidSignature("signature is malleable: s is in the upper half of the curve order");
    }

    const signer = await recoverAddress({ hash: proposal.digest, signature });

    const isOwner = await client.readContract({
        address: proposal.vault,
        abi: vaultAbi,
        functionName: "isOwner",
        args: [signer],
    });
    if (!isOwner) throw new NotAVaultOwner(signer);

    try {
        await pool.query(
            "INSERT INTO vault_signatures (proposal_id, signer, signature) VALUES ($1, $2, $3)",
            [proposal.id, signer.toLowerCase(), signature],
        );
    } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateSignature(signer);
        throw error;
    }

    const { rows } = await pool.query<{ collected: bigint }>(
        "SELECT COUNT(*) AS collected FROM vault_signatures WHERE proposal_id = $1",
        [proposal.id],
    );

    return {
        signer,
        collected: Number(one(rows, "signature count").collected),
        threshold: proposal.threshold,
    };
}

/**
 * The transaction in which the vault executed this proposal's call, if it did.
 *
 * Filtered by the indexed nonce, so the node returns at most one log per vault
 * however long the range: that is what makes searching from genesis
 * affordable even on providers that cap unfiltered log queries.
 */
async function findExecution(client: PublicClient, proposal: Proposal): Promise<Hex | undefined> {
    const logs = await client.getContractEvents({
        address: proposal.vault,
        abi: vaultAbi,
        eventName: "Executed",
        args: { nonce: proposal.nonce },
        fromBlock: "earliest",
    });

    const match = logs.find(
        (log) =>
            log.args.to?.toLowerCase() === proposal.to.toLowerCase() &&
            log.args.value === proposal.value &&
            log.args.data?.toLowerCase() === proposal.data.toLowerCase(),
    );
    return match?.transactionHash ?? undefined;
}

export type SubmissionOutcome =
    | { kind: "executed"; transactionHash: Hex }
    | { kind: "reverted"; reason: string };

/**
 * Submits a proposal that has reached its quorum.
 *
 * Signatures go on chain sorted by signer, strictly ascending, and exactly
 * `threshold` of them: that is the only shape the vault accepts, and it is the
 * rule that stops one owner's signature standing in for several.
 *
 * The row stays locked for the duration, so two operators pressing "submit" at
 * once cannot both broadcast. A revert leaves the proposal open -- the vault
 * reverts its nonce along with everything else, so the approval is still good.
 */
export async function submitProposal(
    deps: { pool: Pool; client: PublicClient; wallet: WalletClient },
    proposalId: bigint,
): Promise<SubmissionOutcome> {
    const { pool, client, wallet } = deps;

    // Stale and expired are returned out of the transaction rather than thrown
    // inside it. Throwing would roll back the very status change that records
    // them -- the caller would be told "stale" while the row still said
    // "collecting", which is how the first version behaved.
    const outcome = await withTransaction(pool, async (tx): Promise<
        | SubmissionOutcome
        | { kind: "stale"; proposed: bigint; current: bigint }
        | { kind: "expired" }
    > => {
        const { rows } = await tx.query<ProposalRow>(
            "SELECT * FROM vault_proposals WHERE id = $1 FOR UPDATE",
            [proposalId],
        );
        const row = rows[0];
        if (row === undefined) throw new ProposalNotFound(proposalId);
        const proposal = toProposal(row);

        if (proposal.status !== "COLLECTING") {
            throw new ProposalNotOpen(proposal.id, proposal.status);
        }

        const [current, now] = await Promise.all([
            client.readContract({ address: proposal.vault, abi: vaultAbi, functionName: "nonce" }),
            chainNow(client),
        ]);

        // The nonce moved. Either this very proposal executed -- an earlier
        // submission broadcast it, then lost the receipt and rolled back
        // before recording the hash -- or a different approval took the slot.
        // Only the vault's own event can tell those apart, and calling the
        // first one stale would report a transfer that happened as one that
        // never can.
        if (current !== proposal.nonce) {
            const executedHere = await findExecution(client, proposal);
            if (executedHere !== undefined) {
                await tx.query(
                    `UPDATE vault_proposals
                        SET status = 'EXECUTED', transaction_hash = $2, failure = NULL, settled_at = now()
                      WHERE id = $1`,
                    [proposal.id, executedHere],
                );
                return { kind: "executed", transactionHash: executedHere };
            }

            // Another approval executed first. These signatures cover a nonce
            // the vault will never be at again, so no retry can use them.
            await tx.query(
                "UPDATE vault_proposals SET status = 'STALE', settled_at = now() WHERE id = $1",
                [proposal.id],
            );
            return { kind: "stale", proposed: proposal.nonce, current };
        }

        if (now > proposal.deadline) {
            await tx.query(
                "UPDATE vault_proposals SET status = 'EXPIRED', settled_at = now() WHERE id = $1",
                [proposal.id],
            );
            return { kind: "expired" };
        }

        // Lower-case hex addresses of equal length sort the same as the
        // numbers they encode, so this is the vault's ascending order.
        const { rows: signed } = await tx.query<{ signature: string }>(
            "SELECT signature FROM vault_signatures WHERE proposal_id = $1 ORDER BY signer LIMIT $2",
            [proposal.id, proposal.threshold],
        );
        if (signed.length < proposal.threshold) {
            throw new NotEnoughSignatures(signed.length, proposal.threshold);
        }

        const account = wallet.account;
        if (account === undefined) throw new Error("vault submitter has no signing account");

        let hash: Hex;
        try {
            hash = await wallet.writeContract({
                account,
                chain: null,
                address: proposal.vault,
                abi: vaultAbi,
                functionName: "execute",
                args: [
                    proposal.to,
                    proposal.value,
                    proposal.data,
                    proposal.deadline,
                    signed.map((s) => s.signature as Hex),
                ],
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
            await tx.query("UPDATE vault_proposals SET failure = $2 WHERE id = $1", [
                proposal.id,
                reason,
            ]);
            return { kind: "reverted", reason };
        }

        const receipt = await client.waitForTransactionReceipt({ hash });

        // A successful receipt proves nothing by itself -- a lesson this
        // codebase has already paid for twice. Only the vault's own Executed
        // event, for this nonce, says the call happened.
        const executed = parseEventLogs({ abi: vaultAbi, logs: receipt.logs, eventName: "Executed" }).some(
            (log) =>
                log.address.toLowerCase() === proposal.vault.toLowerCase() &&
                log.args.nonce === proposal.nonce,
        );

        if (receipt.status !== "success" || !executed) {
            const reason = `transaction ${hash} did not execute the proposal`;
            await tx.query("UPDATE vault_proposals SET failure = $2 WHERE id = $1", [
                proposal.id,
                reason,
            ]);
            return { kind: "reverted", reason };
        }

        await tx.query(
            `UPDATE vault_proposals
                SET status = 'EXECUTED', transaction_hash = $2, failure = NULL, settled_at = now()
              WHERE id = $1`,
            [proposal.id, hash],
        );
        return { kind: "executed", transactionHash: hash };
    });

    if (outcome.kind === "stale") {
        throw new ProposalStale(proposalId, outcome.proposed, outcome.current);
    }
    if (outcome.kind === "expired") {
        throw new ProposalExpired(proposalId);
    }
    return outcome;
}

export interface ProposalDetail extends Proposal {
    signatures: { signer: Address; signedAt: Date }[];
}

/** A proposal and who has signed it, in the order they signed. */
export async function getProposal(pool: Pool, id: bigint): Promise<ProposalDetail> {
    const proposal = await loadProposal(pool, id);
    const { rows } = await pool.query<{ signer: string; created_at: Date }>(
        "SELECT signer, created_at FROM vault_signatures WHERE proposal_id = $1 ORDER BY created_at, signer",
        [id],
    );
    return {
        ...proposal,
        signatures: rows.map((row) => ({ signer: getAddress(row.signer), signedAt: row.created_at })),
    };
}

/**
 * Proposals the submitter should try: still collecting, at quorum, and with no
 * recorded failure.
 *
 * A failed submission is not retried on its own. Whatever made the vault
 * revert -- an unfunded vault, a target that rejects the call -- will usually
 * still be true a few seconds later, and a submitter that kept trying would
 * spend gas every pass to learn nothing new. A person clears the failure once
 * they have fixed the cause.
 */
export async function findReadyProposals(pool: Pool): Promise<bigint[]> {
    const { rows } = await pool.query<{ id: bigint }>(
        `SELECT p.id
           FROM vault_proposals p
          WHERE p.status = 'COLLECTING'
            AND p.failure IS NULL
            AND (SELECT COUNT(*) FROM vault_signatures s WHERE s.proposal_id = p.id) >= p.threshold
          ORDER BY p.id`,
    );
    return rows.map((row) => row.id);
}

/** Clears a recorded failure so the submitter picks the proposal up again. */
export async function retryProposal(pool: Pool, id: bigint): Promise<Proposal> {
    const proposal = await loadProposal(pool, id);
    if (proposal.status !== "COLLECTING") {
        throw new ProposalNotOpen(proposal.id, proposal.status);
    }

    const { rows } = await pool.query<ProposalRow>(
        "UPDATE vault_proposals SET failure = NULL WHERE id = $1 AND status = 'COLLECTING' RETURNING *",
        [id],
    );
    const row = rows[0];
    // Settled between the read and the update, by a submission in flight.
    if (row === undefined) return retryProposal(pool, id);
    return toProposal(row);
}
