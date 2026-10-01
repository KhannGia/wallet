import type { FastifyInstance } from "fastify";
import type { Address, Hex, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { VaultNotConfigured } from "../vault/errors.ts";
import {
    addSignature,
    createProposal,
    getProposal,
    retryProposal,
    type Proposal,
} from "../vault/proposals.ts";
import { executeTypedDataJson } from "../vault/typed-data.ts";
import { createProposalSchema, proposalIdSchema, signatureSchema } from "./schemas.ts";

/**
 * Proposals as the API returns them. Every uint256 is a decimal string, and the
 * typed data rides along so an owner who arrives late can still sign without
 * reconstructing it.
 */
function present(proposal: Proposal) {
    const call = {
        to: proposal.to,
        value: proposal.value,
        data: proposal.data,
        nonce: proposal.nonce,
        deadline: proposal.deadline,
    };
    return {
        id: proposal.id.toString(),
        vault: proposal.vault,
        chainId: proposal.chainId,
        to: proposal.to,
        value: proposal.value.toString(),
        data: proposal.data,
        nonce: proposal.nonce.toString(),
        deadline: proposal.deadline.toString(),
        threshold: proposal.threshold,
        status: proposal.status,
        transactionHash: proposal.transactionHash,
        failure: proposal.failure,
        digest: proposal.digest,
        typedData: executeTypedDataJson(proposal.vault, proposal.chainId, call),
    };
}

/**
 * The approval workflow for moving reserves out of the vault.
 *
 * There is deliberately no "submit" endpoint. Submitting costs gas, so it needs
 * a key, and the API server holds none -- a separate worker submits whatever
 * has reached its quorum. Nor do these routes need their own authentication to
 * be safe: a signature is only accepted if it recovers to a vault owner, and
 * the vault checks every one again on chain. Anyone may propose; only owners
 * can approve.
 */
export function registerVaultRoutes(
    app: FastifyInstance,
    deps: { pool: Pool; client: PublicClient; vault: string | undefined },
): void {
    const { pool, client } = deps;

    const requireVault = (): Address => {
        if (deps.vault === undefined) throw new VaultNotConfigured();
        return deps.vault as Address;
    };

    app.post("/api/v1/vault/proposals", async (request, reply) => {
        const vault = requireVault();
        const { to, value, data, deadline } = createProposalSchema.parse(request.body);
        const proposal = await createProposal({ pool, client }, { vault, to, value, data, deadline });
        return reply.code(201).send(present(proposal));
    });

    app.get("/api/v1/vault/proposals/:id", async (request) => {
        requireVault();
        const { id } = request.params as { id: string };
        const proposal = await getProposal(pool, proposalIdSchema.parse(id));
        return {
            ...present(proposal),
            signatures: proposal.signatures.map((s) => ({
                signer: s.signer,
                signedAt: s.signedAt.toISOString(),
            })),
        };
    });

    app.post("/api/v1/vault/proposals/:id/signatures", async (request, reply) => {
        requireVault();
        const { id } = request.params as { id: string };
        const { signature } = signatureSchema.parse(request.body);
        const receipt = await addSignature(
            { pool, client },
            proposalIdSchema.parse(id),
            signature as Hex,
        );
        return reply.code(201).send({ ...receipt, ready: receipt.collected >= receipt.threshold });
    });

    // Clears a recorded submission failure once its cause is fixed, handing the
    // proposal back to the submitter.
    app.post("/api/v1/vault/proposals/:id/retry", async (request) => {
        requireVault();
        const { id } = request.params as { id: string };
        return present(await retryProposal(pool, proposalIdSchema.parse(id)));
    });
}
