import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { assertBalanced, resetDatabase } from "../test-support/db.ts";

describe("ledger API", () => {
    let deps: AppDeps;
    let app: ReturnType<typeof buildApp>;

    const createAccount = async (email: string): Promise<string> => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            payload: { email },
        });
        assert.equal(response.statusCode, 201);
        return response.json().accountId;
    };

    const money = (url: string, key: string, payload: Record<string, string>) =>
        app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload });

    before(() => {
        deps = createDeps(loadEnv({ ...process.env, LOG_LEVEL: "error" }));
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
            payload: { email: "addr@test.local" },
        });
        const created = response.json();

        assert.equal(response.statusCode, 201);
        assert.match(created.depositAddress, /^0x[0-9a-fA-F]{40}$/);

        // The same address must be readable back on the account.
        const account = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${created.accountId}`,
        });
        assert.equal(account.json().depositAddress, created.depositAddress);
    });

    it("rejects a money-moving request without an Idempotency-Key", async () => {
        const accountId = await createAccount("nokey@test.local");

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/deposits",
            payload: { accountId, amount: "1000" },
        });

        assert.equal(response.statusCode, 400);
    });

    it("returns the stored result when a deposit is retried with the same key", async () => {
        const accountId = await createAccount("retry@test.local");

        const first = await money("/api/v1/deposits", "k1", { accountId, amount: "1000" });
        const second = await money("/api/v1/deposits", "k1", { accountId, amount: "1000" });

        assert.equal(first.statusCode, 201);
        assert.equal(second.statusCode, 200, "a replay is not a new creation");
        assert.deepEqual(second.json(), first.json());

        // The decisive check: the money moved once, not twice.
        const account = await app.inject({ method: "GET", url: `/api/v1/accounts/${accountId}` });
        assert.equal(account.json().balance, "1000");
        await assertBalanced(deps.pool);
    });

    it("rejects the same key used for a different body", async () => {
        const accountId = await createAccount("reuse@test.local");

        await money("/api/v1/deposits", "k2", { accountId, amount: "1000" });
        const mismatched = await money("/api/v1/deposits", "k2", { accountId, amount: "9999" });

        assert.equal(mismatched.statusCode, 422);
        assert.equal(mismatched.json().error, "idempotency_key_reused");
    });

    it("refuses to overdraw and leaves the balance untouched", async () => {
        const accountId = await createAccount("over@test.local");
        await money("/api/v1/deposits", "k3", { accountId, amount: "500" });

        const response = await money("/api/v1/withdrawals", "k4", { accountId, amount: "501" });

        assert.equal(response.statusCode, 422);
        assert.equal(response.json().error, "insufficient_funds");

        const account = await app.inject({ method: "GET", url: `/api/v1/accounts/${accountId}` });
        assert.equal(account.json().balance, "500");
    });

    it("transfers between accounts and records both sides", async () => {
        const alice = await createAccount("alice@api.local");
        const bob = await createAccount("bob@api.local");
        await money("/api/v1/deposits", "k5", { accountId: alice, amount: "1000" });

        const response = await money("/api/v1/transfers", "k6", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "250",
        });
        assert.equal(response.statusCode, 201);

        const [aliceAccount, bobAccount] = await Promise.all([
            app.inject({ method: "GET", url: `/api/v1/accounts/${alice}` }),
            app.inject({ method: "GET", url: `/api/v1/accounts/${bob}` }),
        ]);
        assert.equal(aliceAccount.json().balance, "750");
        assert.equal(bobAccount.json().balance, "250");
        await assertBalanced(deps.pool);
    });

    it("pages entries newest first with a cursor", async () => {
        const accountId = await createAccount("pager@test.local");
        for (let index = 0; index < 5; index++) {
            await money("/api/v1/deposits", `page-${index}`, { accountId, amount: "100" });
        }

        const firstPage = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${accountId}/entries?limit=2`,
        });
        const body = firstPage.json();

        assert.equal(body.entries.length, 2);
        assert.ok(body.nextCursor, "a further page should be offered");

        const secondPage = await app.inject({
            method: "GET",
            url: `/api/v1/accounts/${accountId}/entries?limit=2&cursor=${body.nextCursor}`,
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
        await money("/api/v1/deposits", "r1", { accountId: alice, amount: "5000" });
        await money("/api/v1/transfers", "r2", {
            fromAccountId: alice,
            toAccountId: bob,
            amount: "1500",
        });
        await money("/api/v1/withdrawals", "r3", { accountId: bob, amount: "500" });

        const response = await app.inject({
            method: "GET",
            url: "/api/v1/admin/reconciliation",
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { balanced: true, ledgerSum: "0", drift: [] });
    });

    it("rejects a malformed amount instead of coercing it", async () => {
        const accountId = await createAccount("bad@test.local");

        for (const amount of ["0", "-5", "1.5", "abc", ""]) {
            const response = await money("/api/v1/deposits", `bad-${amount}`, { accountId, amount });
            assert.equal(response.statusCode, 400, `amount ${JSON.stringify(amount)} should be rejected`);
        }
    });
});
