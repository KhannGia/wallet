import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain } from "@wallet/shared";
import { custom, encodeFunctionData, erc20Abi, http, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createBundlerClient,
    createPaymasterClient,
    entryPoint08Abi,
    entryPoint08Address,
    type BundlerClient,
} from "viem/account-abstraction";

import type { Pool } from "../db/pool.ts";
import {
    advanceChainTime,
    chainHarness,
    deployMockUsdc,
    loadArtifact,
    mintTo,
    sendEther,
    type ChainHarness,
} from "../test-support/chain.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { buildPaymasterServer } from "./paymaster/server.ts";
import { createSponsor, registerSmartAccount } from "./paymaster/sponsor.ts";
import { openKey, parseMasterKey, sealKey, sessionAad } from "./sessions/crypto.ts";
import { createSessionManager } from "./sessions/manager.ts";
import { buildSessionServer } from "./sessions/server.ts";
import { toWalletSmartAccount } from "./smart-account.ts";

describe("sealing session keys", () => {
    const master = randomBytes(32);
    const key = generatePrivateKey();
    const aad = sessionAad("0x00000000000000000000000000000000000000aa", privateKeyToAccount(key).address);

    it("opens what it sealed", () => {
        assert.equal(openKey(master, sealKey(master, key, aad), aad), key);
    });

    it("never reuses an IV, so the same key seals differently each time", () => {
        const first = sealKey(master, key, aad);
        const second = sealKey(master, key, aad);
        assert.notDeepEqual(first.iv, second.iv);
        assert.notDeepEqual(first.ciphertext, second.ciphertext);
    });

    it("refuses a ciphertext that was altered", () => {
        const sealed = sealKey(master, key, aad);
        sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 1;
        assert.throws(() => openKey(master, sealed, aad));
    });

    it("refuses another master key", () => {
        assert.throws(() => openKey(randomBytes(32), sealKey(master, key, aad), aad));
    });

    /** A ciphertext moved to another session's row must not open there. */
    it("refuses a ciphertext swapped onto another session", () => {
        const sealed = sealKey(master, key, aad);
        const elsewhere = sessionAad("0x00000000000000000000000000000000000000bb", privateKeyToAccount(key).address);
        assert.throws(() => openKey(master, sealed, elsewhere));
    });

    it("accepts only a 32-byte master key", () => {
        assert.equal(parseMasterKey("0x" + "ab".repeat(32)).length, 32);
        assert.throws(() => parseMasterKey("ab".repeat(16)), /32 bytes/);
    });
});

describe("the session manager, through the bundler", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let bundler: BundlerClient;
    let factory: Address;
    let token: Address;
    let app: ReturnType<typeof buildSessionServer>;
    const masterKey = randomBytes(32);
    const TOKEN = "t".repeat(40);
    const auth = { authorization: `Bearer ${TOKEN}` };

    async function deploy(name: string, args: unknown[]): Promise<Address> {
        const artifact = await loadArtifact(name);
        const hash = await harness.walletClient.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
            account: harness.walletClient.account ?? null,
            chain: localChain,
        });
        return (await harness.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    }

    before(async () => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        if (env.BUNDLER_URL === undefined) throw new Error("BUNDLER_URL is not set");
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        bundler = createBundlerClient({ client: harness.publicClient, transport: http(env.BUNDLER_URL) });
        factory = await deploy("AccountFactory", [entryPoint08Address]);
        token = await deployMockUsdc(harness);

        // A paymaster and its ERC-7677 service, wired in-process, so session
        // operations can be sponsored.
        const sponsorKey = privateKeyToAccount(generatePrivateKey());
        const paymaster = await deploy("VerifyingPaymaster", [
            entryPoint08Address,
            sponsorKey.address,
            harness.walletClient.account!.address,
        ]);
        const funded = await harness.walletClient.writeContract({
            address: paymaster,
            abi: parseAbi(["function deposit() payable"]),
            functionName: "deposit",
            value: 10n ** 18n,
            account: harness.walletClient.account!,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash: funded });
        const sponsorApp = buildPaymasterServer(
            createSponsor(
                { pool, client: harness.publicClient, signer: sponsorKey },
                {
                    paymaster,
                    entryPoint: entryPoint08Address,
                    chainId: localChain.id,
                    factory,
                    token,
                    dailyCapWei: 10n ** 17n,
                    ttlSeconds: 300,
                },
            ),
            "error",
        );
        const paymasterClient = createPaymasterClient({
            transport: custom({
                async request({ method, params }) {
                    const response = await sponsorApp.inject({
                        method: "POST",
                        url: "/",
                        payload: { jsonrpc: "2.0", id: 1, method, params },
                    });
                    const body = response.json();
                    if (body.error) throw new Error(body.error.message);
                    return body.result;
                },
            }),
        });

        const manager = createSessionManager(
            { pool, client: harness.publicClient, bundler, paymaster: paymasterClient },
            { masterKey, keyVersion: 1, factory },
        );
        app = buildSessionServer(manager, TOKEN, "error");
    });

    beforeEach(async () => {
        await resetDatabase(pool);
    });

    after(async () => {
        await app.close();
        await pool.end();
    });

    const fresh = () => privateKeyToAccount(generatePrivateKey());
    const balance = (address: Address) =>
        harness.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const transferData = (to: Address, amount: bigint): Hex =>
        encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

    /** A deployed account with a little ether for its owner's own operations, and USDC. */
    async function ownedAccount() {
        const owner = fresh();
        const account = await toWalletSmartAccount({ client: harness.publicClient, owner, factory });
        await sendEther(harness, account.address, 10n ** 17n);
        await mintTo(harness, token, account.address, 1_000_000_000n);
        await registerSmartAccount(pool, { address: account.address, owner: owner.address });
        const hash = await bundler.sendUserOperation({ account, calls: [{ to: fresh().address, value: 0n }] });
        await bundler.waitForUserOperationReceipt({ hash });
        return account;
    }

    /** An app asks for a 24-hour session: transfers of the token, 100 USDC in total. */
    async function createSession(account: Address, validForSeconds = 86_400) {
        const response = await app.inject({
            method: "POST",
            url: "/sessions",
            headers: auth,
            payload: {
                account,
                validForSeconds,
                permissions: [{ target: token, selector: "0xa9059cbb", conditions: [] }],
                limits: [{ token, limit: "100000000" }],
            },
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json();
    }

    /** The owner grants it, from their own wallet. */
    async function grant(account: Awaited<ReturnType<typeof ownedAccount>>, call: { to: Address; data: Hex }) {
        const hash = await bundler.sendUserOperation({ account, calls: [call] });
        assert.equal((await bundler.waitForUserOperationReceipt({ hash })).success, true);
    }

    const operate = (id: string, payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url: `/sessions/${id}/operations`, headers: auth, payload });

    it("lets an app holding only a token spend within the session, gas sponsored", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address);
        await grant(account, session.grant);
        const etherBefore = await harness.publicClient.getBalance({ address: account.address });

        const recipient = fresh().address;
        const response = await operate(session.id, { to: token, data: transferData(recipient, 60_000_000n), sponsored: true });

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().success, true);
        assert.equal(await balance(recipient), 60_000_000n);
        assert.equal(
            await harness.publicClient.getBalance({ address: account.address }),
            etherBefore,
            "the paymaster paid; the account spent no ether",
        );
    });

    it("refuses a call past the cap before sending it, so no gas is wasted", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address);
        await grant(account, session.grant);
        await operate(session.id, { to: token, data: transferData(fresh().address, 60_000_000n), sponsored: true });
        const nonceBefore = await harness.publicClient.readContract({
            address: entryPoint08Address,
            abi: entryPoint08Abi,
            functionName: "getNonce",
            args: [account.address, BigInt(session.sessionKey)],
        });

        const over = await operate(session.id, { to: token, data: transferData(fresh().address, 60_000_000n), sponsored: true });

        assert.equal(over.statusCode, 422);
        assert.equal(over.json().error, "over_limit");
        const nonceAfter = await harness.publicClient.readContract({
            address: entryPoint08Address,
            abi: entryPoint08Abi,
            functionName: "getNonce",
            args: [account.address, BigInt(session.sessionKey)],
        });
        assert.equal(nonceAfter, nonceBefore, "nothing was sent");
    });

    it("waits for the owner to grant a session before using it", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address);

        const early = await operate(session.id, { to: token, data: transferData(fresh().address, 1n) });

        assert.equal(early.statusCode, 409);
        assert.equal(early.json().error, "session_not_granted");
    });

    it("shreds the key on revocation, and hands back the call that ends it on chain", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address);
        await grant(account, session.grant);

        const revoked = await app.inject({ method: "DELETE", url: `/sessions/${session.id}`, headers: auth });
        assert.equal(revoked.statusCode, 200);

        const { rows } = await pool.query("SELECT status, ciphertext FROM session_keys WHERE id = $1", [session.id]);
        assert.equal(rows[0].status, "REVOKED");
        assert.equal(rows[0].ciphertext, null, "the key is gone, not just flagged");
        assert.equal((await operate(session.id, { to: token, data: transferData(fresh().address, 1n) })).statusCode, 410);

        // Still live on the account until the owner sends this.
        await grant(account, revoked.json().revoke);
        const [active] = await harness.publicClient.readContract({
            address: account.address,
            abi: parseAbi(["function sessions(address) view returns (bool, uint48, uint48, uint256, uint256)"]),
            functionName: "sessions",
            args: [session.sessionKey],
        });
        assert.equal(active, false);
    });

    it("notices an owner's revocation on chain and shreds its copy", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address);
        await grant(account, session.grant);
        await operate(session.id, { to: token, data: transferData(fresh().address, 1n) });

        const revokeOnChain = encodeFunctionData({
            abi: parseAbi(["function revokeSession(address key)"]),
            functionName: "revokeSession",
            args: [session.sessionKey],
        });
        await grant(account, { to: account.address, data: revokeOnChain });

        const after = await operate(session.id, { to: token, data: transferData(fresh().address, 1n) });
        assert.equal(after.statusCode, 410);
        const { rows } = await pool.query("SELECT status, ciphertext FROM session_keys WHERE id = $1", [session.id]);
        assert.equal(rows[0].status, "REVOKED");
        assert.equal(rows[0].ciphertext, null);
    });

    it("shreds keys of sessions that have expired", async () => {
        const account = await ownedAccount();
        const session = await createSession(account.address, 60);
        await advanceChainTime(harness, 61);

        const response = await operate(session.id, { to: token, data: transferData(fresh().address, 1n) });

        assert.equal(response.statusCode, 410);
        const { rows } = await pool.query("SELECT status, ciphertext FROM session_keys WHERE id = $1", [session.id]);
        assert.equal(rows[0].status, "EXPIRED");
        assert.equal(rows[0].ciphertext, null);
    });

    it("keeps the private key sealed: never returned, never stored in the clear", async () => {
        const account = await ownedAccount();
        const created = await app.inject({
            method: "POST",
            url: "/sessions",
            headers: auth,
            payload: {
                account: account.address,
                validForSeconds: 3600,
                permissions: [{ target: token, selector: "0xa9059cbb", conditions: [] }],
            },
        });
        const body = created.json();
        const fetched = (await app.inject({ method: "GET", url: `/sessions/${body.id}`, headers: auth })).json();

        const { rows } = await pool.query("SELECT ciphertext, iv, auth_tag FROM session_keys WHERE id = $1", [body.id]);
        const privateKey = openKey(masterKey, { ciphertext: rows[0].ciphertext, iv: rows[0].iv, tag: rows[0].auth_tag }, sessionAad(account.address, body.sessionKey));

        // The stored key is the one the session names, and it appears nowhere
        // the API sends or the database holds in the clear.
        assert.equal(privateKeyToAccount(privateKey).address, body.sessionKey);
        const plaintext = privateKey.slice(2);
        assert.equal(created.body.toLowerCase().includes(plaintext), false);
        assert.equal(JSON.stringify(fetched).toLowerCase().includes(plaintext), false);
        assert.equal(rows[0].ciphertext.toString("hex").includes(plaintext), false);
    });

    it("answers only to the bearer token", async () => {
        const anonymous = await app.inject({ method: "POST", url: "/sessions", payload: {} });
        assert.equal(anonymous.statusCode, 401);
        const wrong = await app.inject({
            method: "GET",
            url: "/sessions/1",
            headers: { authorization: `Bearer ${"x".repeat(40)}` },
        });
        assert.equal(wrong.statusCode, 401);
        assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    });
});
