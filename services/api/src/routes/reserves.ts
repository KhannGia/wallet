import type { FastifyInstance } from "fastify";
import type { Address, PublicClient } from "viem";

import type { Pool } from "../db/pool.ts";
import { USDC_SCANNER_ID } from "../chain/indexer.ts";
import { NoReservesSnapshot, ReservesNotConfigured } from "../reserves/errors.ts";
import {
    latestReservesSnapshot,
    takeReservesSnapshot,
    type ReservesConfig,
    type StoredSnapshot,
} from "../reserves/reserves.ts";

function present(snapshot: StoredSnapshot) {
    return {
        id: snapshot.id.toString(),
        token: snapshot.token,
        blockNumber: snapshot.blockNumber.toString(),
        assets: snapshot.assets.toString(),
        liabilities: snapshot.liabilities.toString(),
        surplus: snapshot.surplus.toString(),
        solvent: snapshot.solvent,
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
    deps: { pool: Pool; client: PublicClient; token: string | undefined; vault: string | undefined },
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

    app.get("/api/v1/admin/reserves", async (_request, reply) => {
        requireConfig();
        const snapshot = await latestReservesSnapshot(pool);
        if (snapshot === null) throw new NoReservesSnapshot();
        return reply.code(snapshot.solvent ? 200 : 500).send(present(snapshot));
    });

    app.post("/api/v1/admin/reserves", async (_request, reply) => {
        await takeReservesSnapshot({ pool, client }, requireConfig());
        const snapshot = await latestReservesSnapshot(pool);
        if (snapshot === null) throw new NoReservesSnapshot();
        return reply.code(snapshot.solvent ? 201 : 500).send(present(snapshot));
    });
}
