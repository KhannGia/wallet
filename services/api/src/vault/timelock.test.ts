import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv, localChain, type Env } from "@wallet/shared";
import { createWalletClient, http, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { buildApp, createDeps, type AppDeps } from "../app.ts";
import {
    advanceChainTime,
    anvilSigner,
    chainHarness,
    deployMultisigVault,
    sendEther,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { resetDatabase } from "../test-support/db.ts";
import { vaultAbi } from "./abi.ts";
import { submitReadyProposals } from "./submitter.ts";
import { executeTypedData } from "./typed-data.ts";

const ONE_ETHER = 10n ** 18n;
const DELAY = 3600n;
const GRACE_PERIOD = 14n * 24n * 3600n;

describe("vault timelock in the backend", () => {
    let env: Env;
    let harness: ChainHarness;
    let submitter: Signer;
    let shared: AppDeps;
    let app: ReturnType<typeof buildApp> | undefined;
    let owners: PrivateKeyAccount[];
    let vault: Address;
    let hot: Address;

    before(() => {
        env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        shared = createDeps(env);
        harness = chainHarness(env.RPC_URL);
        submitter = anvilSigner(env.RPC_URL, 3);
    });

    beforeEach(async () => {
        owners = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())).sort(
            (a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1),
        );
        hot = freshAddress();

        // An hour's delay, and up to one ether a day straight to the hot wallet.
        vault = await deployMultisigVault(harness, owners.map((o) => o.address), 3n, {
            delay: DELAY,
            hotWallet: hot,
            assets: ["0x0000000000000000000000000000000000000000"],
            limits: [ONE_ETHER],
        });
        await sendEther(harness, vault, 5n * ONE_ETHER);

        await app?.close();
        app = buildApp({ ...shared, env: { ...env, VAULT_ADDRESS: vault } });
        await resetDatabase(shared.pool);
    });

    after(async () => {
        await app?.close();
        await shared.pool.end();
    });

    function freshAddress(): Address {
        return privateKeyToAccount(generatePrivateKey()).address;
    }

    const read = async (id: string) =>
        (await app!.inject({ method: "GET", url: `/api/v1/vault/proposals/${id}` })).json();

    const submit = () =>
        submitReadyProposals({
            pool: shared.pool,
            client: harness.publicClient,
            wallet: submitter.walletClient,
        });

    /** Opens a proposal and has three owners approve it. */
    async function approved(to: Address, value: bigint) {
        const now = (await harness.publicClient.getBlock()).timestamp;
        const created = await app!.inject({
            method: "POST",
            url: "/api/v1/vault/proposals",
            payload: { to, value: value.toString(), deadline: (now + 7200n).toString() },
        });
        assert.equal(created.statusCode, 201);
        const proposal = created.json();

        const call = {
            to,
            value,
            data: "0x" as Hex,
            nonce: BigInt(proposal.nonce),
            deadline: BigInt(proposal.deadline),
        };
        const signatures: Hex[] = [];
        for (const owner of owners.slice(0, 3)) {
            const signature = await owner.signTypedData(executeTypedData(vault, proposal.chainId, call));
            const response = await app!.inject({
                method: "POST",
                url: `/api/v1/vault/proposals/${proposal.id}/signatures`,
                payload: { signature },
            });
            assert.equal(response.statusCode, 201);
            signatures.push(signature);
        }
        return { proposal, call, signatures };
    }

    it("tops up the hot wallet at once, within the allowance", async () => {
        const { proposal } = await approved(hot, ONE_ETHER / 2n);

        const [report] = await submit();

        assert.equal(report?.outcome.kind, "executed");
        assert.equal(await harness.publicClient.getBalance({ address: hot }), ONE_ETHER / 2n);
        const settled = await read(proposal.id);
        assert.equal(settled.status, "EXECUTED");
        assert.equal(settled.eta, null, "nothing was queued");
    });

    it("queues what the vault holds back, and executes it after the delay", async () => {
        const recipient = freshAddress();
        const { proposal } = await approved(recipient, 2n * ONE_ETHER);

        const [queued] = await submit();
        assert.equal(queued?.outcome.kind, "queued");

        const waiting = await read(proposal.id);
        assert.equal(waiting.status, "QUEUED");
        assert.match(waiting.queueTransactionHash, /^0x[0-9a-f]{64}$/);
        assert.ok(waiting.cancel, "owners are handed the call that cancels it");

        // Before the delay: nothing moves, however often the submitter runs.
        const [early] = await submit();
        assert.equal(early?.outcome.kind, "waiting");
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 0n);

        await advanceChainTime(harness, Number(DELAY));
        const [late] = await submit();
        assert.equal(late?.outcome.kind, "executed");

        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 2n * ONE_ETHER);
        const executed = await read(proposal.id);
        assert.equal(executed.status, "EXECUTED");
        assert.notEqual(executed.transactionHash, executed.queueTransactionHash);
        assert.equal(executed.cancel, null);
    });

    it("records an owner's cancellation made straight against the vault", async () => {
        const recipient = freshAddress();
        const { proposal } = await approved(recipient, 2n * ONE_ETHER);
        await submit();

        // One owner, from their own wallet, sends the call the API handed out.
        const { cancel } = await read(proposal.id);
        const owner = owners[4]!;
        await sendEther(harness, owner.address, ONE_ETHER / 10n);
        const ownerWallet = createWalletClient({
            account: owner,
            chain: localChain,
            transport: http(env.RPC_URL),
        });
        const hash = await ownerWallet.sendTransaction({ to: cancel.to, data: cancel.data });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        const [report] = await submit();
        assert.equal(report?.outcome.kind, "cancelled");
        assert.equal((await read(proposal.id)).status, "CANCELLED");

        // Settled for good: past the delay, it is neither retried nor executed.
        await advanceChainTime(harness, Number(DELAY));
        assert.deepEqual(await submit(), []);
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 0n);
    });

    it("expires a queued call nobody executed within the grace period", async () => {
        const { proposal } = await approved(freshAddress(), 2n * ONE_ETHER);
        await submit();

        await advanceChainTime(harness, Number(DELAY + GRACE_PERIOD + 1n));
        const [report] = await submit();

        assert.equal(report?.outcome.kind, "expired");
        assert.equal((await read(proposal.id)).status, "EXPIRED");
    });

    it("keeps a failed execution queued until someone retries it", async () => {
        // More than the vault holds. Queueing does not check the balance;
        // executing does.
        const recipient = freshAddress();
        const { proposal } = await approved(recipient, 8n * ONE_ETHER);
        await submit();
        await advanceChainTime(harness, Number(DELAY));

        const [failed] = await submit();
        assert.equal(failed?.outcome.kind, "reverted");
        const stuck = await read(proposal.id);
        assert.equal(stuck.status, "QUEUED", "still queued on chain, still executable");
        assert.ok(stuck.failure);

        // Recorded failures are left alone, so the next pass spends nothing.
        assert.deepEqual(await submit(), []);

        await sendEther(harness, vault, 5n * ONE_ETHER);
        const retried = await app!.inject({
            method: "POST",
            url: `/api/v1/vault/proposals/${proposal.id}/retry`,
        });
        assert.equal(retried.statusCode, 200);

        const [report] = await submit();
        assert.equal(report?.outcome.kind, "executed");
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 8n * ONE_ETHER);
    });

    it("recognises its own queueing after losing the receipt", async () => {
        const { proposal, call, signatures } = await approved(freshAddress(), 2n * ONE_ETHER);

        // The queue reached the chain, but the submitter rolled back before
        // recording it. The vault has spent the nonce on this very proposal.
        const sorted = signatures.slice(); // owners[0..2] signed, already ascending
        const hash = await submitter.walletClient.writeContract({
            account: submitter.walletClient.account!,
            chain: null,
            address: vault,
            abi: vaultAbi,
            functionName: "queue",
            args: [call.to, call.value, call.data, call.deadline, sorted],
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        const [report] = await submit();

        // Not stale: the nonce moved because of this proposal.
        assert.equal(report?.outcome.kind, "queued");
        const recovered = await read(proposal.id);
        assert.equal(recovered.status, "QUEUED");
        assert.equal(recovered.queueTransactionHash, hash);
    });

    it("opens the next proposal while one waits in the queue", async () => {
        await approved(freshAddress(), 2n * ONE_ETHER);
        await submit();

        // The queued call already spent nonce 0; nothing holds up nonce 1.
        const { proposal } = await approved(hot, ONE_ETHER / 4n);
        assert.equal(proposal.nonce, "1");

        const reports = await submit();
        assert.deepEqual(
            reports.map((r) => r.outcome.kind).sort(),
            ["executed", "waiting"],
        );
    });
});
