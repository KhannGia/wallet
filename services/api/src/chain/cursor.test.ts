import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Pool } from "../db/pool.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { advanceCursor, loadCursor } from "./cursor.ts";

describe("scanner cursor", () => {
    let pool: Pool;

    before(() => {
        pool = testPool();
    });
    beforeEach(async () => {
        await resetDatabase(pool);
    });
    after(async () => {
        await pool.end();
    });

    it("starts at the given block the first time and remembers it after", async () => {
        assert.equal(await loadCursor(pool, "usdc", 500n), 500n);

        // The start block is a first-run default, not an override: honouring it
        // on every call would rescan history after each restart.
        assert.equal(await loadCursor(pool, "usdc", 9_000n), 500n);
    });

    it("keeps separate scanners independent", async () => {
        await loadCursor(pool, "usdc", 100n);
        await loadCursor(pool, "weth", 700n);

        await advanceCursor(pool, "usdc", 150n);

        assert.equal(await loadCursor(pool, "usdc", 0n), 150n);
        assert.equal(await loadCursor(pool, "weth", 0n), 700n);
    });

    it("advances forward", async () => {
        await loadCursor(pool, "usdc", 10n);
        await advanceCursor(pool, "usdc", 42n);

        assert.equal(await loadCursor(pool, "usdc", 0n), 42n);
    });

    it("refuses to rewind", async () => {
        await loadCursor(pool, "usdc", 10n);
        await advanceCursor(pool, "usdc", 100n);

        // A stale or out-of-order scan result must not move the cursor back:
        // the range would be rescanned and every deposit in it credited twice.
        // Rewinding after a reorg is a separate, deliberate operation.
        await advanceCursor(pool, "usdc", 50n);

        assert.equal(await loadCursor(pool, "usdc", 0n), 100n);
    });

    it("survives a restart without losing its place", async () => {
        await loadCursor(pool, "usdc", 0n);
        await advanceCursor(pool, "usdc", 1_234n);

        // A fresh pool stands in for a restarted process.
        const reopened = testPool();
        try {
            assert.equal(await loadCursor(reopened, "usdc", 0n), 1_234n);
        } finally {
            await reopened.end();
        }
    });
});
