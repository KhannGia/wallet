import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { adminHeaders, TEST_ADMIN_TOKEN } from "../test-support/auth.ts";
import { assertBalanced, creditForTest, resetDatabase } from "../test-support/db.ts";

const PASSWORD = "correct horse battery staple";

describe("signing in, and who may touch which account", () => {
    let deps: AppDeps;
    let app: ReturnType<typeof buildApp>;

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

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    async function signUp(email: string, password = PASSWORD) {
        const response = await app.inject({ method: "POST", url: "/api/v1/users", payload: { email, password } });
        assert.equal(response.statusCode, 201, response.body);
        return response.json() as { userId: string; accountId: string; token: string };
    }

    const signIn = (email: string, password: string) =>
        app.inject({ method: "POST", url: "/api/v1/sessions", payload: { email, password } });

    const account = (accountId: string, headers: Record<string, string> = {}) =>
        app.inject({ method: "GET", url: `/api/v1/accounts/${accountId}`, headers });

    it("signs a new user in, and keeps only a hash of the password", async () => {
        const alice = await signUp("Alice@Example.com");
        assert.match(alice.token, /^[A-Za-z0-9_-]{43}$/);

        const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: bearer(alice.token) });
        assert.equal(me.statusCode, 200, me.body);
        assert.equal(me.json().email, "alice@example.com", "stored lower-cased");
        assert.equal(me.json().accounts[0].accountId, alice.accountId);
        assert.equal((await account(alice.accountId, bearer(alice.token))).statusCode, 200);

        const { rows } = await deps.pool.query<{ password_hash: string }>("SELECT password_hash FROM users");
        assert.match(rows[0]!.password_hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
        assert.equal(rows[0]!.password_hash.includes(PASSWORD), false);

        // Sessions are stored as hashes too: the token itself is nowhere.
        const { rows: sessions } = await deps.pool.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
        assert.equal(sessions.some((session) => session.token_hash.includes(alice.token)), false);
    });

    it("signs in with the right password, whatever the email's case, and refuses anything else alike", async () => {
        await signUp("bob@example.com");

        const ok = await signIn("BOB@example.com", PASSWORD);
        assert.equal(ok.statusCode, 201, ok.body);
        assert.equal((await account((await app.inject({ method: "GET", url: "/api/v1/me", headers: bearer(ok.json().token) })).json().accounts[0].accountId, bearer(ok.json().token))).statusCode, 200);

        // A wrong password and an unknown email answer exactly the same.
        const wrong = await signIn("bob@example.com", "not the password");
        const unknown = await signIn("nobody@example.com", PASSWORD);
        assert.equal(wrong.statusCode, 401);
        assert.deepEqual(wrong.json(), unknown.json());
        assert.equal(wrong.json().error, "invalid_credentials");
    });

    it("refuses a second account for one email, and a short password", async () => {
        await signUp("carol@example.com");
        const again = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            payload: { email: "CAROL@example.com", password: PASSWORD },
        });
        assert.equal(again.statusCode, 409);
        assert.equal(again.json().error, "email_taken");

        const short = await app.inject({ method: "POST", url: "/api/v1/users", payload: { email: "d@example.com", password: "short" } });
        assert.equal(short.statusCode, 400);
    });

    it("answers 401 without a session, with a made-up one, after signing out, and once it expires", async () => {
        const erin = await signUp("erin@example.com");
        assert.equal((await account(erin.accountId)).statusCode, 401);
        assert.equal((await account(erin.accountId, bearer("made-up-token"))).statusCode, 401);
        assert.equal((await account(erin.accountId, { authorization: "Basic xyz" })).statusCode, 401);

        // Signing out ends that session; another stays open.
        const second = (await signIn("erin@example.com", PASSWORD)).json().token;
        const out = await app.inject({ method: "DELETE", url: "/api/v1/sessions/current", headers: bearer(erin.token) });
        assert.equal(out.statusCode, 204);
        assert.equal((await account(erin.accountId, bearer(erin.token))).statusCode, 401);
        assert.equal((await account(erin.accountId, bearer(second))).statusCode, 200);
        assert.equal(
            (await app.inject({ method: "DELETE", url: "/api/v1/sessions/current", headers: bearer(erin.token) })).statusCode,
            401,
        );

        await deps.pool.query(
            "UPDATE auth_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'",
        );
        assert.equal((await account(erin.accountId, bearer(second))).statusCode, 401);
    });

    it("keeps each account to its owner: another user's is not found, and its money does not move", async () => {
        const frank = await signUp("frank@example.com");
        const grace = await signUp("grace@example.com");
        await creditForTest(deps.pool, { accountId: BigInt(grace.accountId), amount: 1_000n, idempotencyKey: "grace" });

        const peek = await account(grace.accountId, bearer(frank.token));
        assert.equal(peek.statusCode, 404);
        assert.equal(peek.json().error, "account_not_found");
        assert.equal(
            (await app.inject({ method: "GET", url: `/api/v1/accounts/${grace.accountId}/entries`, headers: bearer(frank.token) }))
                .statusCode,
            404,
        );

        const steal = await app.inject({
            method: "POST",
            url: "/api/v1/transfers",
            headers: { ...bearer(frank.token), "idempotency-key": "steal" },
            payload: { fromAccountId: grace.accountId, toAccountId: frank.accountId, amount: "1000" },
        });
        assert.equal(steal.statusCode, 404);
        const payout = await app.inject({
            method: "POST",
            url: "/api/v1/payouts",
            headers: { ...bearer(frank.token), "idempotency-key": "steal-2" },
            payload: { accountId: grace.accountId, to: "0x000000000000000000000000000000000000dEaD", amount: "1000" },
        });
        assert.equal(payout.statusCode, 404);
        assert.equal((await account(grace.accountId, bearer(grace.token))).json().balance, "1000");

        // Paying someone else needs only their account id.
        const gift = await app.inject({
            method: "POST",
            url: "/api/v1/transfers",
            headers: { ...bearer(grace.token), "idempotency-key": "gift" },
            payload: { fromAccountId: grace.accountId, toAccountId: frank.accountId, amount: "300" },
        });
        assert.equal(gift.statusCode, 201, gift.body);
        await assertBalanced(deps.pool);
    });

    it("keeps idempotency keys apart per user", async () => {
        const henry = await signUp("henry@example.com");
        const ivy = await signUp("ivy@example.com");
        for (const who of [henry, ivy]) {
            await creditForTest(deps.pool, { accountId: BigInt(who.accountId), amount: 1_000n, idempotencyKey: who.accountId });
        }

        // The same key from two users is two requests, not a replay of the first.
        const send = (from: typeof henry, to: typeof henry) =>
            app.inject({
                method: "POST",
                url: "/api/v1/transfers",
                headers: { ...bearer(from.token), "idempotency-key": "same-key" },
                payload: { fromAccountId: from.accountId, toAccountId: to.accountId, amount: "100" },
            });
        assert.equal((await send(henry, ivy)).statusCode, 201);
        assert.equal((await send(ivy, henry)).statusCode, 201);
        assert.equal((await account(henry.accountId, bearer(henry.token))).json().balance, "1000");
        assert.equal((await account(ivy.accountId, bearer(ivy.token))).json().balance, "1000");
    });

    it("guards the admin endpoints with the operator's token, not a user's", async () => {
        const jack = await signUp("jack@example.com");
        const reconcile = (headers: Record<string, string>) =>
            app.inject({ method: "GET", url: "/api/v1/admin/reconciliation", headers });

        assert.equal((await reconcile({})).statusCode, 401);
        assert.equal((await reconcile(bearer(jack.token))).statusCode, 401);
        assert.equal((await reconcile(bearer(`${TEST_ADMIN_TOKEN}x`))).statusCode, 401);
        assert.equal((await reconcile(adminHeaders)).statusCode, 200);

        const unconfigured = buildApp({ ...deps, env: { ...deps.env, API_ADMIN_TOKEN: undefined } });
        assert.equal((await unconfigured.inject({ method: "GET", url: "/api/v1/admin/reconciliation", headers: adminHeaders })).statusCode, 503);
        await unconfigured.close();
    });
});
