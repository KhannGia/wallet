import { sumProofToJson } from "@wallet/shared";
import type { FastifyInstance } from "fastify";
import type { Address, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { requireAccountOwner, requireAdmin } from "../auth/sessions.ts";
import { USDC_SCANNER_ID } from "../chain/indexer.ts";
import { NoReservesSnapshot, ReservesNotConfigured } from "../reserves/errors.ts";
import { proveLiability } from "../reserves/proofs.ts";
import {
    latestReservesSnapshot,
    takeReservesSnapshot,
    type ReservesConfig,
    type StoredSnapshot,
} from "../reserves/reserves.ts";
import { accountIdSchema, proposalIdSchema } from "./schemas.ts";

function present(snapshot: StoredSnapshot) {
    return {
        id: snapshot.id.toString(),
        token: snapshot.token,
        blockNumber: snapshot.blockNumber.toString(),
        assets: snapshot.assets.toString(),
        liabilities: snapshot.liabilities.toString(),
        surplus: snapshot.surplus.toString(),
        solvent: snapshot.solvent,
        rootHash: snapshot.rootHash,
        detail: snapshot.detail,
        createdAt: snapshot.createdAt.toISOString(),
    };
}

/**
 * Reserves against liabilities. A shortfall answers 500, as an unbalanced
 * ledger does, so an alert can watch the status rather than parse the body.
 */
export function registerReservesRoutes(
    app: FastifyInstance,
    deps: {
        pool: Pool;
        client: PublicClient;
        token: string | undefined;
        vault: string | undefined;
        adminToken: string | undefined;
    },
): void {
    const { pool, client } = deps;
    const requireConfig = (): ReservesConfig => {
        if (deps.token === undefined) throw new ReservesNotConfigured();
        return {
            token: deps.token as Address,
            ...(deps.vault === undefined ? {} : { vault: deps.vault as Address }),
            scannerId: USDC_SCANNER_ID,
        };
    };

    app.get("/api/v1/admin/reserves", async (request, reply) => {
        requireAdmin(request, deps.adminToken);
        requireConfig();
        const snapshot = await latestReservesSnapshot(pool);
        if (snapshot === null) throw new NoReservesSnapshot();
        return reply.code(snapshot.solvent ? 200 : 500).send(present(snapshot));
    });

    // Public: what any user needs to check their own balance against the
    // total. The latest snapshot's root, and each user's proof into it.
    app.get("/api/v1/reserves/latest", async () => {
        requireConfig();
        const snapshot = await latestReservesSnapshot(pool);
        if (snapshot === null) throw new NoReservesSnapshot();
        const { detail: _detail, ...summary } = present(snapshot);
        return summary;
    });

    app.get("/api/v1/reserves/:id/proof/:accountId", async (request) => {
        requireConfig();
        const params = request.params as { id: string; accountId: string };
        const accountId = accountIdSchema.parse(params.accountId);
        // A proof carries the salt that hides the balance from everyone else.
        await requireAccountOwner(pool, request, accountId);
        const { snapshot, root, proof } = await proveLiability(pool, proposalIdSchema.parse(params.id), accountId);
        return {
            snapshotId: snapshot.id.toString(),
            token: snapshot.token,
            blockNumber: snapshot.blockNumber.toString(),
            root: { hash: root.hash, sum: root.sum.toString() },
            proof: sumProofToJson(proof),
        };
    });

    app.post("/api/v1/admin/reserves", async (request, reply) => {
        requireAdmin(request, deps.adminToken);
        await takeReservesSnapshot({ pool, client }, requireConfig());
        const snapshot = await latestReservesSnapshot(pool);
        if (snapshot === null) throw new NoReservesSnapshot();
        return reply.code(snapshot.solvent ? 201 : 500).send(present(snapshot));
    });
}
