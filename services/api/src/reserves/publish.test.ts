import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import { createWalletClient, erc20Abi, getAddress, http, type Address, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import { runIndexerOnce, USDC_SCANNER_ID } from "../chain/indexer.ts";
import { createUser } from "../ledger/operations.ts";
import {
    anvilSigner,
    chainHarness,
    deployMockUsdc,
    loadArtifact,
    mintTo,
    sendEther,
    type ChainHarness,
} from "../test-support/chain.ts";
import { sessionFor } from "../test-support/auth.ts";
import { resetDatabase, TEST_XPUB } from "../test-support/db.ts";
import { reservesRegistryAbi, runReservesOnce } from "./publisher.ts";
import { takeReservesSnapshot } from "./reserves.ts";
import { verifyAgainstRegistry } from "./verify.ts";

const OUTSIDE = "0x000000000000000000000000000000000000dEaD" as Address;

describe("proof of reserves: published on chain, verified by the user", () => {
    let env: Env;
    let harness: ChainHarness;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp>;
    let token: Address;
    let registry: Address;
    let startBlock: bigint;
    const publisherKey = privateKeyToAccount(generatePrivateKey());
    const publisher = () => createWalletClient({ account: publisherKey, chain: localChain, transport: http(env.RPC_URL) });

    before(async () => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        harness = chainHarness(env.RPC_URL);
        shared = createDeps(env);
        await sendEther(harness, publisherKey.address, 10n ** 18n);
    });

    async function deployRegistry(trusting: Address): Promise<Address> {
        const artifact = await loadArtifact("ReservesRegistry");
        const hash = await harness.walletClient.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [trusting, token],
            account: harness.walletClient.account ?? null,
            chain: localChain,
        });
        return (await harness.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    }

    beforeEach(async () => {
        await resetDatabase(shared.pool);
        token = await deployMockUsdc(harness);
        registry = await deployRegistry(publisherKey.address);
        startBlock = await harness.publicClient.getBlockNumber();
        app = buildApp({ ...shared, env: { ...shared.env, USDC_ADDRESS: token } });
    });

    after(async () => {
        await app.close();
        await shared.pool.end();
    });

    const deps = () => ({ pool: shared.pool, client: harness.publicClient, wallet: publisher() });
    const config = () => ({ token, scannerId: USDC_SCANNER_ID, registry });
    const index = () =>
        runIndexerOnce(
            { pool: shared.pool, client: harness.publicClient },
            { scannerId: USDC_SCANNER_ID, token, startBlock, finality: { kind: "confirmations", depth: 1n } },
        );

    /** Users funded through real deposits; index 0 is skipped, being the harness's own account. */
    async function funded(amounts: bigint[]) {
        await createUser(shared.pool, { email: "skip-index-0@publish.local", xpub: TEST_XPUB });
        const users = [];
        for (const [i, amount] of amounts.entries()) {
            const created = await createUser(shared.pool, { email: `u${i}@publish.local`, xpub: TEST_XPUB });
            await mintTo(harness, token, created.depositAddress as Address, amount);
            users.push({
                accountId: BigInt(created.accountId),
                address: created.depositAddress as Address,
                signer: anvilSigner(env.RPC_URL, Number(created.derivationIndex)),
            });
        }
        await index();
        return users;
    }

    const proofOf = async (snapshotId: bigint, accountId: bigint) => {
        const response = await app.inject({
            method: "GET",
            url: `/api/v1/reserves/${snapshotId}/proof/${accountId}`,
            headers: await sessionFor(shared.pool, accountId),
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
    };

    it("publishes each snapshot's root, and a user verifies their share against it", async () => {
        const [alice, bob] = await funded([1_000_000n, 3_000_000n]);
        const run = await runReservesOnce(deps(), config());
        assert.equal(run.publication.kind, "published");
        assert.equal(run.solvent, true);

        // On chain, exactly what was snapshotted.
        const [id, attested] = await harness.publicClient.readContract({
            address: registry,
            abi: reservesRegistryAbi,
            functionName: "latest",
        });
        const { rows } = await shared.pool.query(
            "SELECT root_hash, liabilities, assets, block_number, attestation_id, publish_tx FROM reserve_snapshots WHERE id = $1",
            [run.snapshotId],
        );
        assert.equal(attested.root, rows[0].root_hash);
        assert.equal(attested.liabilities, 4_000_000n);
        assert.equal(attested.assets, 4_000_000n);
        assert.equal(attested.blockNumber, rows[0].block_number);
        assert.equal(rows[0].attestation_id, id.toString());
        assert.match(rows[0].publish_tx, /^0x[0-9a-f]{64}$/);

        // Each user, with nothing but their proof and the chain.
        for (const [who, owed] of [[alice!, 1_000_000n], [bob!, 3_000_000n]] as const) {
            const verdict = await verifyAgainstRegistry(harness.publicClient, registry, await proofOf(run.snapshotId, who.accountId));
            assert.equal(verdict.valid, true, JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
            if (!verdict.valid) continue;
            assert.equal(verdict.accountId, who.accountId);
            assert.equal(verdict.amount, owed);
            assert.equal(verdict.attestationId, id);
            assert.equal(verdict.liabilities, 4_000_000n);
            assert.equal(verdict.token, getAddress(token));
        }
    });

    it("refuses a proof that was altered, and one whose root was never published", async () => {
        const [alice] = await funded([1_000_000n, 3_000_000n]);
        const run = await runReservesOnce(deps(), config());
        const document = await proofOf(run.snapshotId, alice!.accountId);

        // Claiming more than was owed leads to a root nobody published.
        const inflated = { ...document, proof: { ...document.proof, leaf: { ...document.proof.leaf, amount: "1000001" } } };
        const verdict = await verifyAgainstRegistry(harness.publicClient, registry, inflated);
        assert.equal(verdict.valid, false);
        assert.match(verdict.valid ? "" : verdict.reason, /never published/);

        // The API naming a different root changes nothing: the verifier
        // computes the root itself.
        const misdirected = { ...document, root: { hash: `0x${"11".repeat(32)}`, sum: "1" } };
        assert.equal((await verifyAgainstRegistry(harness.publicClient, registry, misdirected)).valid, true);

        // A snapshot taken but never published: its proofs lead nowhere.
        const unpublished = await takeReservesSnapshot(deps(), config());
        const orphan = await verifyAgainstRegistry(harness.publicClient, registry, await proofOf(unpublished.id, alice!.accountId));
        assert.match(orphan.valid ? "" : orphan.reason, /never published/);

        // The right root published with the wrong total: the proof sums to
        // something else, and that is caught too.
        const misstated = await takeReservesSnapshot(deps(), config());
        const hash = await publisher().writeContract({
            address: registry,
            abi: reservesRegistryAbi,
            functionName: "publish",
            args: [misstated.root.hash, misstated.report.liabilities.total - 1n, 0n, misstated.report.blockNumber],
            account: publisherKey,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });
        const understated = await verifyAgainstRegistry(
            harness.publicClient,
            registry,
            await proofOf(misstated.id, alice!.accountId),
        );
        assert.match(understated.valid ? "" : understated.reason, /published total/);

        const malformed = await verifyAgainstRegistry(harness.publicClient, registry, { proof: { leaf: {} } });
        assert.match(malformed.valid ? "" : malformed.reason, /^malformed proof/);
    });

    it("publishes a shortfall like any other snapshot", async () => {
        const [alice] = await funded([2_000_000n]);
        await (async () => {
            const hash = await alice!.signer.walletClient.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: "transfer",
                args: [OUTSIDE, 500_000n],
                account: alice!.signer.walletClient.account ?? null,
                chain: localChain,
            });
            await harness.publicClient.waitForTransactionReceipt({ hash });
        })();
        await index();

        const run = await runReservesOnce(deps(), config());
        assert.equal(run.solvent, false);
        assert.equal(run.publication.kind, "published");
        const [, attested] = await harness.publicClient.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "latest" });
        assert.equal(attested.liabilities, 2_000_000n);
        assert.equal(attested.assets, 1_500_000n, "the shortfall is on chain for anyone to see");
    });

    it("records a failed publication and carries on", async () => {
        await funded([1_000_000n]);
        // A registry that trusts some other key.
        const elsewhere = await deployRegistry(privateKeyToAccount(generatePrivateKey()).address);
        const run = await runReservesOnce(deps(), { ...config(), registry: elsewhere });
        assert.equal(run.publication.kind, "failed");

        const { rows } = await shared.pool.query(
            "SELECT attestation_id, publish_failure FROM reserve_snapshots WHERE id = $1",
            [run.snapshotId],
        );
        assert.equal(rows[0].attestation_id, null);
        assert.match(rows[0].publish_failure, /NotPublisher|revert/i);

        // With no registry, or no key, a snapshot is still taken.
        const local = await runReservesOnce({ pool: shared.pool, client: harness.publicClient }, { token, scannerId: USDC_SCANNER_ID });
        assert.deepEqual(local.publication, { kind: "skipped", reason: "no registry configured" });
        const keyless = await runReservesOnce({ pool: shared.pool, client: harness.publicClient }, config());
        assert.deepEqual(keyless.publication, { kind: "skipped", reason: "no publisher key" });
    });

    it("waits rather than publish a block before the last one", async () => {
        await funded([1_000_000n]);
        assert.equal((await runReservesOnce(deps(), config())).publication.kind, "published");

        // A reorg rewinds the indexer's cursor below what was published.
        await shared.pool.query("UPDATE indexer_state SET last_scanned_block = last_scanned_block - 1 WHERE id = $1", [
            USDC_SCANNER_ID,
        ]);
        const run = await runReservesOnce(deps(), config());
        assert.equal(run.publication.kind, "skipped");
        assert.match(run.publication.kind === "skipped" ? run.publication.reason : "", /before the last published/);
    });

    it("recognises a publication whose receipt was lost", async () => {
        await funded([1_000_000n]);
        // Taken and published, but the process stopped before recording it.
        const snapshot = await takeReservesSnapshot(deps(), config());
        const hash: Hash = await publisher().writeContract({
            address: registry,
            abi: reservesRegistryAbi,
            functionName: "publish",
            args: [snapshot.root.hash, snapshot.report.liabilities.total, snapshot.report.assets.total, snapshot.report.blockNumber],
            account: publisherKey,
            chain: localChain,
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        const run = await runReservesOnce(deps(), config());
        assert.equal(run.recovered, 1);
        const { rows } = await shared.pool.query("SELECT attestation_id, registry_address FROM reserve_snapshots WHERE id = $1", [
            snapshot.id,
        ]);
        assert.equal(rows[0].attestation_id, "0");
        assert.equal(rows[0].registry_address, registry);
        assert.equal((await runReservesOnce(deps(), config())).recovered, 0, "found once, not every pass");
    });

    it("does not mistake an empty tree's root, which every empty snapshot shares, for another's publication", async () => {
        // No users: every snapshot has the same root.
        assert.equal((await runReservesOnce(deps(), config())).publication.kind, "published");
        const elsewhere = await deployRegistry(privateKeyToAccount(generatePrivateKey()).address);
        const failed = await runReservesOnce(deps(), { ...config(), registry: elsewhere });
        assert.equal(failed.publication.kind, "failed");

        assert.equal((await runReservesOnce(deps(), config())).recovered, 0);
        const { rows } = await shared.pool.query("SELECT attestation_id FROM reserve_snapshots WHERE id = $1", [
            failed.snapshotId,
        ]);
        assert.equal(rows[0].attestation_id, null);
    });
});
