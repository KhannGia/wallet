import { computeSumRoot, sumProofFromJson, verifySumProof, type SumProof } from "@wallet/shared";
import type { Address, PublicClient } from "viem";

import { reservesRegistryAbi } from "./publisher.ts";

export type Verdict =
    | {
          valid: true;
          accountId: bigint;
          amount: bigint;
          attestationId: bigint;
          blockNumber: bigint;
          liabilities: bigint;
          assets: bigint;
          token: Address;
      }
    | { valid: false; reason: string };

/**
 * What a user runs on the proof the API gave them.
 *
 * Nothing from the platform is trusted except the proof itself. The root it
 * leads to is computed here, then looked up in the registry on chain -- not
 * taken from the API's response, which could name any root it liked -- and
 * the proof must sum to exactly the total published with it.
 */
export async function verifyAgainstRegistry(
    client: PublicClient,
    registry: Address,
    document: unknown,
): Promise<Verdict> {
    let proof: SumProof;
    let root;
    try {
        proof = sumProofFromJson((document as { proof?: unknown } | null)?.proof);
        root = computeSumRoot(proof);
    } catch (error) {
        return { valid: false, reason: `malformed proof: ${error instanceof Error ? error.message : String(error)}` };
    }

    const found = await client
        .readContract({ address: registry, abi: reservesRegistryAbi, functionName: "findByRoot", args: [root.hash] })
        .catch(() => undefined);
    if (found === undefined) {
        return { valid: false, reason: `the root ${root.hash} was never published to ${registry}` };
    }
    const [attestationId, attestation] = found;

    const checked = verifySumProof(proof, { hash: attestation.root, sum: attestation.liabilities });
    if (!checked.valid) return checked;

    const token = await client.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "token" });
    return {
        valid: true,
        accountId: proof.leaf.accountId,
        amount: proof.leaf.amount,
        attestationId,
        blockNumber: attestation.blockNumber,
        liabilities: attestation.liabilities,
        assets: attestation.assets,
        token,
    };
}
