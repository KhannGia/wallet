import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { adminHeaders, TEST_ADMIN_TOKEN } from "../test-support/auth.ts";
import { assertBalanced, creditForTest, resetDatabase } from "../test-support/db.ts";

const PASSWORD = "correct horse battery staple";

describe("ledger API", () => {
    let deps: AppDeps;
    let app: ReturnType<typeof buildApp>;

    /** Each account's sign-in, from signing up. */
    const tokens = new Map<string, string>();
    const as = (accountId: string | undefined) => ({ authorization: `Bearer ${tokens.get(accountId ?? "")}` });

    const createAccount = async (email: string): Promise<string> => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            payload: { email, password: PASSWORD },
        });
        assert.equal(response.statusCode, 201, response.body);
        tokens.set(response.json().accountId, response.json().token);
        return response.json().accountId;
    };

    /** Sent as whoever owns the account the money leaves. */
    const money = (url: string, key: string, payload: Record<string, string>) =>
        app.inject({
            method: "POST",
            url,
            headers: { "idempotency-key": key, ...as(payload.fromAccountId ?? payload.accountId) },
            payload,
        });

    /** Stands in for a deposit the indexer would credit; the API itself cannot create money. */
    const fund = (accountId: string, amount: bigint) =>
        creditForTest(deps.pool, { accountId: BigInt(accountId), amount, idempotencyKey: `fund-${accountId}` });

    before(() => {
        deps = createDeps(loadEnv({ ...process.env, LOG_LEVEL: "error", API_ADMIN_TOKEN: TEST_ADMIN_TOKEN }));
        app = buildApp(deps);
    });
    beforeEach(async () => {
        await resetDatabase(deps.pool);
    });
    after(async () => {
        await app.close();
        await deps.pool.end();
    });

    it("returns a deposit address when an account is created", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            payload: { email: "addr@test.local", password: PASSWORD },
        });
        const created = response.json();

        assert.equal(response.statusCode, 201);
        assert.match(created.depositAddress, /^0x[0-9a-fA-F]{40}$/);

        // The same address must be readable back on the account.
        const account = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${created.accountId}`,
            headers: { authorization: `Bearer ${created.token}` },
        });
        assert.equal(account.json().depositAddress, created.depositAddress);
    });

    it("rejects a money-moving request without an Idempotency-Key", async () => {
        const alice = await createAccount("nokey-a@test.local");
        const bob = await createAccount("nokey-b@test.local");
        await fund(alice, 1000n);

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/transfers",
            headers: as(alice),
            payload: { fromAccountId: alice, toAccountId: bob, amount: "100" },
        });

        assert.equal(response.statusCode, 400);
    });

    it("returns the stored result when a transfer is retried with the same key", async () => {
        const alice = await createAccount("retry-a@test.local");
        const bob = await createAccount("retry-b@test.local");
        await fund(alice, 1000n);

        const body = { fromAccountId: alice, toAccountId: bob, amount: "400" };
        const first = await money("/api/v1/transfers", "k1", body);
        const second = await money("/api/v1/transfers", "k1", body);

        assert.equal(first.statusCode, 201);
        assert.equal(second.statusCode, 200, "a replay is not a new creation");
        assert.deepEqual(second.json(), first.json());

        // The decisive check: the money moved once, not twice.
        const account = await app.inject({ method: "GET", url: `/api/v1/accounts/${bob}`, headers: as(bob) });
        assert.equal(account.json().balance, "400");
        await assertBalanced(deps.pool);
    });

    it("rejects the same key used for a different body", async () => {
        const alice = await createAccount("reuse-a@test.local");
        const bob = await createAccount("reuse-b@test.local");
        await fund(alice, 1000n);

        await money("/api/v1/transfers", "k2", { fromAccountId: alice, toAccountId: bob, amount: "100" });
        const mismatched = await money("/api/v1/transfers", "k2", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "999",
        });

        assert.equal(mismatched.statusCode, 422);
        assert.equal(mismatched.json().error, "idempotency_key_reused");
    });

    it("refuses to overdraw and leaves the balance untouched", async () => {
        const alice = await createAccount("over-a@test.local");
        const bob = await createAccount("over-b@test.local");
        await fund(alice, 500n);

        const response = await money("/api/v1/transfers", "k4", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "501",
        });

        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error, "insufficient_funds");

        const account = await app.inject({ method: "GET", url: `/api/v1/accounts/${alice}`, headers: as(alice) });
        assert.equal(account.json().balance, "500");
    });

    it("transfers between accounts and records both sides", async () => {
        const alice = await createAccount("alice@api.local");
        const bob = await createAccount("bob@api.local");
        await fund(alice, 1000n);

        const response = await money("/api/v1/transfers", "k6", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "250",
        });
        assert.equal(response.statusCode, 201);

        const [aliceAccount, bobAccount] = await Promise.all([
            app.inject({ method: "GET", url: `/api/v1/accounts/${alice}`, headers: as(alice) }),
            app.inject({ method: "GET", url: `/api/v1/accounts/${bob}`, headers: as(bob) }),
        ]);
        assert.equal(aliceAccount.json().balance, "750");
        assert.equal(bobAccount.json().balance, "250");
        await assertBalanced(deps.pool);
    });

    it("pages entries newest first with a cursor", async () => {
        const accountId = await createAccount("pager@test.local");
        const other = await createAccount("pager-b@test.local");
        await fund(accountId, 1000n);
        for (let index = 0; index < 4; index++) {
            await money("/api/v1/transfers", `page-${index}`, {
                fromAccountId: accountId,
                toAccountId: other,
                amount: "100",
            });
        }

        const firstPage = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${accountId}/entries?limit=2`,
            headers: as(accountId),
        });
        const body = firstPage.json();

        assert.equal(body.entries.length, 2);
        assert.ok(body.nextCursor, "a further page should be offered");

        const secondPage = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${accountId}/entries?limit=2&cursor=${body.nextCursor}`,
            headers: as(accountId),
        });
        const secondBody = secondPage.json();

        assert.equal(secondBody.entries.length, 2);
        // Pages must not overlap.
        const firstIds = body.entries.map((entry: { id: string }) => entry.id);
        const secondIds = secondBody.entries.map((entry: { id: string }) => entry.id);
        assert.equal(firstIds.some((id: string) => secondIds.includes(id)), false);
    });

    it("reports a balanced ledger after a mix of operations", async () => {
        const alice = await createAccount("recon-a@test.local");
        const bob = await createAccount("recon-b@test.local");
        await fund(alice, 5000n);
        await money("/api/v1/transfers", "r2", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "1500",
        });
        await money("/api/v1/transfers", "r3", {
            fromAccountId: bob,
            toAccountId: alice,
            amount: "500",
        });

        const response = await app.inject({
            method: "GET",
            url: "/api/v1/admin/reconciliation",
            headers: adminHeaders,
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
            balanced: true,
            ledgerSum: "0",
            drift: [],
            // Nothing is parked: these operations never went through the chain.
            parked: { held: "0", owed: "0", matches: true },
            reserved: { held: "0", owed: "0", matches: true },
        });
    });

    it("rejects a malformed amount instead of coercing it", async () => {
        const alice = await createAccount("bad-a@test.local");
        const bob = await createAccount("bad-b@test.local");
        await fund(alice, 1000n);

        for (const amount of ["0", "-5", "1.5", "abc", ""]) {
            const response = await money("/api/v1/transfers", `bad-${amount}`, {
                fromAccountId: alice,
                toAccountId: bob,
                amount,
            });
            assert.equal(response.statusCode, 400, `amount ${JSON.stringify(amount)} should be rejected`);
        }
    });

    it("offers no way to create or destroy money outside the chain", async () => {
        const accountId = await createAccount("nobank@test.local");

        // The simulated bank endpoints are gone: a balance comes only from a
        // deposit the indexer sees, and leaves only as a payout.
        for (const url of ["/api/v1/deposits", "/api/v1/withdrawals"]) {
            const response = await money(url, `gone-${url}`, { accountId, amount: "1000" });
            assert.equal(response.statusCode, 404, url);
        }
        const account = await app.inject({ method: "GET", url: `/api/v1/accounts/${accountId}`, headers: as(accountId) });
        assert.equal(account.json().balance, "0");
    });
});
