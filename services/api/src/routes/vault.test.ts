import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, type Env } from "@wallet/shared";
import { hashTypedData, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import {
    anvilSigner,
    chainHarness,
    deployMultisigVault,
    sendEther,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { resetDatabase } from "../test-support/db.ts";
import { vaultAbi } from "../vault/abi.ts";
import { submitReadyProposals } from "../vault/submitter.ts";

const ONE_ETHER = 10n ** 18n;

/** The JSON typed data the API returns, as a wallet receives it. */
interface TypedDataJson {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: "Execute";
    message: { to: Address; value: string; data: Hex; nonce: string; deadline: string };
}

/**
 * What an owner's wallet does with the API's typed data. Integers arrive as
 * decimal strings, exactly as eth_signTypedData_v4 receives them; the wallet
 * reads them as numbers. EIP712Domain is dropped because viem derives it from
 * the domain itself.
 */
function signJson(owner: PrivateKeyAccount, typed: TypedDataJson): Promise<Hex> {
    const { EIP712Domain: _domain, ...types } = typed.types;
    return owner.signTypedData({
        domain: typed.domain,
        types,
        primaryType: typed.primaryType,
        message: {
            ...typed.message,
            value: BigInt(typed.message.value),
            nonce: BigInt(typed.message.nonce),
            deadline: BigInt(typed.message.deadline),
        },
    });
}

describe("vault API", () => {
    let env: Env;
    let harness: ChainHarness;
    let submitter: Signer;
    let owners: PrivateKeyAccount[];
    let vault: Address;
    let shared: AppDeps;
    let deps: AppDeps;
    let app: ReturnType<typeof buildApp> | undefined;

    before(() => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        shared = createDeps(env);
        harness = chainHarness(env.RPC_URL);
        submitter = anvilSigner(env.RPC_URL, 5);
    });

    beforeEach(async () => {
        owners = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())).sort(
            (a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1),
        );
        vault = await deployMultisigVault(harness, owners.map((o) => o.address), 3n);
        await sendEther(harness, vault, 5n * ONE_ETHER);

        // The vault is configuration, so each test gets an app built for its
        // own freshly deployed one, sharing one pool and chain client.
        await app?.close();
        deps = { ...shared, env: { ...env, VAULT_ADDRESS: vault } };
        app = buildApp(deps);
        await resetDatabase(deps.pool);
    });

    after(async () => {
        await app?.close();
        await shared.pool.end();
    });

    const freshRecipient = (): Address => privateKeyToAccount(generatePrivateKey()).address;

    const deadlineIn = async (seconds: bigint): Promise<string> =>
        ((await harness.publicClient.getBlock()).timestamp + seconds).toString();

    const propose = async (payload: Record<string, unknown>) =>
        app!.inject({ method: "POST", url: "/api/v1/vault/proposals", payload });

    const sign = (id: string, signature: Hex) =>
        app!.inject({
            method: "POST",
            url: `/api/v1/vault/proposals/${id}/signatures`,
            payload: { signature },
        });

    const read = async (id: string) =>
        (await app!.inject({ method: "GET", url: `/api/v1/vault/proposals/${id}` })).json();

    const submit = () =>
        submitReadyProposals({
            pool: deps.pool,
            client: harness.publicClient,
            wallet: submitter.walletClient,
        });

    it("hands out typed data that hashes to the digest the vault verifies", async () => {
        const response = await propose({
            to: freshRecipient(),
            value: (2n * ONE_ETHER).toString(),
            deadline: await deadlineIn(3600n),
        });
        assert.equal(response.statusCode, 201);
        const body = response.json();

        // A wallet signs the JSON it is given, not the server's internal form,
        // so that JSON is what has to agree with the contract.
        const { EIP712Domain: _domain, ...types } = body.typedData.types;
        const fromJson = hashTypedData({
            domain: body.typedData.domain,
            types,
            primaryType: "Execute",
            message: {
                ...body.typedData.message,
                value: BigInt(body.typedData.message.value),
                nonce: BigInt(body.typedData.message.nonce),
                deadline: BigInt(body.typedData.message.deadline),
            },
        });
        const onChain = await harness.publicClient.readContract({
            address: vault,
            abi: vaultAbi,
            functionName: "hashExecute",
            args: [body.to, BigInt(body.value), body.data, BigInt(body.nonce), BigInt(body.deadline)],
        });

        assert.equal(fromJson, onChain);
        assert.equal(body.digest, onChain);
        // A uint256 never travels as a JSON number.
        assert.equal(body.value, "2000000000000000000");
    });

    it("takes a proposal from creation to execution over HTTP", async () => {
        const recipient = freshRecipient();
        const created = (
            await propose({
                to: recipient,
                value: ONE_ETHER.toString(),
                deadline: await deadlineIn(3600n),
            })
        ).json();

        for (const [index, owner] of [owners[4]!, owners[1]!, owners[2]!].entries()) {
            const response = await sign(created.id, await signJson(owner, created.typedData));
            assert.equal(response.statusCode, 201);
            assert.equal(response.json().collected, index + 1);
            assert.equal(response.json().ready, index === 2);
        }

        const collecting = await read(created.id);
        assert.equal(collecting.status, "COLLECTING");
        assert.deepEqual(
            new Set(collecting.signatures.map((s: { signer: Address }) => s.signer)),
            new Set([owners[4]!.address, owners[1]!.address, owners[2]!.address]),
        );

        const reports = await submit();
        assert.equal(reports.length, 1);
        assert.equal(reports[0]?.outcome.kind, "executed");

        const executed = await read(created.id);
        assert.equal(executed.status, "EXECUTED");
        assert.match(executed.transactionHash, /^0x[0-9a-f]{64}$/);
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), ONE_ETHER);
    });

    it("leaves a proposal below quorum alone", async () => {
        const created = (
            await propose({ to: freshRecipient(), value: "1", deadline: await deadlineIn(3600n) })
        ).json();
        await sign(created.id, await signJson(owners[0]!, created.typedData));

        assert.deepEqual(await submit(), []);
        assert.equal((await read(created.id)).status, "COLLECTING");
    });

    it("does not resubmit a failed proposal until someone retries it", async () => {
        // More than the vault holds: execute reverts with CallFailed.
        const recipient = freshRecipient();
        const created = (
            await propose({
                to: recipient,
                value: (8n * ONE_ETHER).toString(),
                deadline: await deadlineIn(3600n),
            })
        ).json();
        for (const owner of owners.slice(0, 3)) {
            await sign(created.id, await signJson(owner, created.typedData));
        }

        const first = await submit();
        assert.equal(first[0]?.outcome.kind, "reverted");

        const failed = await read(created.id);
        assert.equal(failed.status, "COLLECTING", "a revert leaves the approval usable");
        assert.ok(failed.failure, "the reason is recorded for whoever investigates");

        // Nothing has changed, so trying again would only spend gas.
        assert.deepEqual(await submit(), []);

        // The cause is fixed and a person says so.
        await sendEther(harness, vault, 5n * ONE_ETHER);
        const retried = await app!.inject({
            method: "POST",
            url: `/api/v1/vault/proposals/${created.id}/retry`,
        });
        assert.equal(retried.statusCode, 200);
        assert.equal(retried.json().failure, null);

        const second = await submit();
        assert.equal(second[0]?.outcome.kind, "executed");
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 8n * ONE_ETHER);
    });

    it("maps signature rejections to their statuses", async () => {
        const created = (
            await propose({ to: freshRecipient(), value: "1", deadline: await deadlineIn(3600n) })
        ).json();

        const outsider = await sign(
            created.id,
            await signJson(privateKeyToAccount(generatePrivateKey()), created.typedData),
        );
        assert.equal(outsider.statusCode, 403);
        assert.equal(outsider.json().error, "not_a_vault_owner");

        const signature = await signJson(owners[0]!, created.typedData);
        await sign(created.id, signature);
        const duplicate = await sign(created.id, signature);
        assert.equal(duplicate.statusCode, 409);
        assert.equal(duplicate.json().error, "duplicate_signature");

        const truncated = await sign(created.id, signature.slice(0, 100) as Hex);
        assert.equal(truncated.statusCode, 422);
        assert.equal(truncated.json().error, "invalid_signature");

        const missing = await sign("999999", signature);
        assert.equal(missing.statusCode, 404);
    });

    it("rejects malformed proposals before they reach the chain", async () => {
        const deadline = await deadlineIn(3600n);
        const cases: Record<string, unknown>[] = [
            { to: "0x1234", value: "1", deadline },
            // Valid hex, wrong EIP-55 checksum: likely a typo.
            { to: "0x52908400098527886e0F7030069857D2E4169EE7", value: "1", deadline },
            { to: freshRecipient(), value: "-1", deadline },
            { to: freshRecipient(), value: "1.5", deadline },
            { to: freshRecipient(), value: (2n ** 256n).toString(), deadline },
            { to: freshRecipient(), value: "1", data: "0xabc", deadline },
            { to: freshRecipient(), value: 1, deadline },
            { to: freshRecipient(), value: "1" },
        ];

        for (const payload of cases) {
            const response = await propose(payload);
            assert.equal(response.statusCode, 400, `should reject ${JSON.stringify(payload)}`);
        }

        const badId = await app!.inject({ method: "GET", url: "/api/v1/vault/proposals/abc" });
        assert.equal(badId.statusCode, 400);
    });

    it("answers 503 when no vault is configured", async () => {
        const unconfigured = buildApp({ ...deps, env: { ...env, VAULT_ADDRESS: undefined } });
        try {
            const response = await unconfigured.inject({
                method: "POST",
                url: "/api/v1/vault/proposals",
                payload: { to: freshRecipient(), value: "1", deadline: await deadlineIn(3600n) },
            });
            assert.equal(response.statusCode, 503);
            assert.equal(response.json().error, "vault_not_configured");
        } finally {
            await unconfigured.close();
        }
    });
});
