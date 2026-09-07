import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveDepositAddress } from "@wallet/shared";

import type { Pool } from "../db/pool.ts";
import { resetDatabase, testPool, TEST_XPUB } from "../test-support/db.ts";
import { createUser } from "./operations.ts";

// Published in anvil's startup banner, so this is an independent expectation
// rather than a value produced by the code under test.
const ANVIL_ADDRESSES = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

describe("deposit address assignment", () => {
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

    it("hands out the expected addresses in order", async () => {
        for (const [index, expected] of ANVIL_ADDRESSES.entries()) {
            const created = await createUser(pool, { email: `u${index}@test.local`, xpub: TEST_XPUB });
            assert.equal(created.derivationIndex, String(index));
            assert.equal(created.depositAddress, expected);
        }
    });

    it("never reuses an index when signups race", async () => {
        // nextval is the whole reason this holds: MAX(index) + 1 under
        // concurrency would hand two users the same address, silently merging
        // their deposits into one balance.
        const created = await Promise.all(
            Array.from({ length: 25 }, (_unused, i) =>
                createUser(pool, { email: `race${i}@test.local`, xpub: TEST_XPUB }),
            ),
        );

        const indices = new Set(created.map((user) => user.derivationIndex));
        const addresses = new Set(created.map((user) => user.depositAddress));

        assert.equal(indices.size, 25, "derivation indices must be unique");
        assert.equal(addresses.size, 25, "deposit addresses must be unique");
    });

    it("stores an address that matches independent derivation", async () => {
        const created = await createUser(pool, { email: "check@test.local", xpub: TEST_XPUB });

        const { rows } = await pool.query<{ deposit_address: string; derivation_index: bigint }>(
            "SELECT deposit_address, derivation_index FROM accounts WHERE id = $1",
            [BigInt(created.accountId)],
        );
        const row = rows[0];
        assert.ok(row);

        assert.equal(
            row.deposit_address,
            deriveDepositAddress(TEST_XPUB, Number(row.derivation_index)),
        );
    });

    it("gives system accounts no on-chain address", async () => {
        const { rows } = await pool.query<{ deposit_address: string | null; system_key: string }>(
            "SELECT deposit_address, system_key FROM accounts WHERE type = 'SYSTEM'",
        );

        assert.ok(rows.length > 0);
        for (const row of rows) {
            assert.equal(row.deposit_address, null, `${row.system_key} should have no address`);
        }
    });

    it("refuses a user account without an address at the database level", async () => {
        const { rows } = await pool.query<{ id: bigint }>(
            "INSERT INTO users (email) VALUES ('noaddr@test.local') RETURNING id",
        );
        const user = rows[0];
        assert.ok(user);

        await assert.rejects(
            pool.query("INSERT INTO accounts (user_id, type) VALUES ($1, 'USER')", [user.id]),
            /accounts_address_matches_type/,
        );
    });

    it("refuses two accounts sharing one address", async () => {
        const first = await createUser(pool, { email: "dup1@test.local", xpub: TEST_XPUB });
        const { rows } = await pool.query<{ id: bigint }>(
            "INSERT INTO users (email) VALUES ('dup2@test.local') RETURNING id",
        );
        const user = rows[0];
        assert.ok(user);

        await assert.rejects(
            pool.query(
                `INSERT INTO accounts (user_id, type, derivation_index, deposit_address)
                 VALUES ($1, 'USER', 999, $2)`,
                [user.id, first.depositAddress],
            ),
            /accounts_deposit_address_key/,
        );
    });
});
