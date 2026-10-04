import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "./env.ts";

const base = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    RPC_URL: "http://localhost:8545",
    WALLET_XPUB: "xpub-placeholder",
};

describe("environment loading", () => {
    it("treats an empty value as unset", () => {
        // This is what `.env.example` ships and what Compose produces for an
        // unset variable. Validating "" as a real value made every service --
        // the migration runner included -- refuse to start.
        const env = loadEnv({ ...base, USDC_ADDRESS: "" });

        assert.equal(env.USDC_ADDRESS, undefined);
    });

    it("falls back to defaults when a value is blank", () => {
        const env = loadEnv({ ...base, LOG_LEVEL: "", FINALITY_CONFIRMATIONS: "" });

        assert.equal(env.LOG_LEVEL, "info");
        assert.equal(env.FINALITY_CONFIRMATIONS, 3);
    });

    it("still rejects a value that is present but malformed", () => {
        assert.throws(
            () => loadEnv({ ...base, USDC_ADDRESS: "not-an-address" }),
            /USDC_ADDRESS/,
        );
    });

    it("defaults finality to the consensus tag, not confirmations", () => {
        // The safe default for a real network. A devnet has to opt out
        // explicitly, rather than a misconfiguration silently crediting
        // deposits that could still be reorganised away.
        assert.equal(loadEnv(base).FINALITY_MODE, "finalized");
    });

    it("requires the variables a service cannot run without", () => {
        assert.throws(() => loadEnv({ RPC_URL: "http://x", WALLET_XPUB: "y" }), /DATABASE_URL/);
    });

    it("leaves rebalancing off unless all three marks are set", () => {
        const env = loadEnv(base);
        assert.equal(env.REBALANCE_LOW, undefined);

        assert.throws(
            () => loadEnv({ ...base, REBALANCE_LOW: "100", REBALANCE_TARGET: "500" }),
            /together, or none/,
        );
    });

    it("requires the rebalancing marks in order", () => {
        const marks = { REBALANCE_LOW: "100", REBALANCE_TARGET: "500", REBALANCE_HIGH: "900" };
        const env = loadEnv({ ...base, ...marks });
        assert.equal(env.REBALANCE_TARGET, 500n);

        // A target outside the band would rebalance straight back out of it.
        assert.throws(
            () => loadEnv({ ...base, ...marks, REBALANCE_TARGET: "1000" }),
            /REBALANCE_LOW < REBALANCE_TARGET < REBALANCE_HIGH/,
        );
    });
});
