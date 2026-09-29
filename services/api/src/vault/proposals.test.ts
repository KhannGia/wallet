import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "@wallet/shared";
import { parseSignature, serializeSignature, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Pool } from "../db/pool.ts";
import {
    advanceChainTime,
    anvilSigner,
    chainHarness,
    deployMultisigVault,
    sendEther,
    type ChainHarness,
    type Signer,
} from "../test-support/chain.ts";
import { resetDatabase, testPool } from "../test-support/db.ts";
import { vaultAbi } from "./abi.ts";
import {
    DeadlineInPast,
    DuplicateSignature,
    InvalidSignature,
    NotAVaultOwner,
    NotEnoughSignatures,
    ProposalAlreadyOpen,
    ProposalExpired,
    ProposalStale,
} from "./errors.ts";
import { addSignature, createProposal, submitProposal, type Proposal } from "./proposals.ts";
import { executeTypedData } from "./typed-data.ts";

const ONE_ETHER = 10n ** 18n;
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("vault proposals", () => {
    let pool: Pool;
    let harness: ChainHarness;
    let submitter: Signer;
    let owners: PrivateKeyAccount[];
    let vault: Address;

    before(() => {
        const env = loadEnv({ ...process.env, LOG_LEVEL: "error" });
        pool = testPool();
        harness = chainHarness(env.RPC_URL);
        submitter = anvilSigner(env.RPC_URL, 4);
    });

    beforeEach(async () => {
        await resetDatabase(pool);

        // Fresh owners and a fresh vault per test: vault nonces and balances
        // live on the chain, which outlives the database.
        owners = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())).sort(
            (a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1),
        );
        vault = await deployMultisigVault(harness, owners.map((o) => o.address), 3n);
        await sendEther(harness, vault, 20n * ONE_ETHER);
    });

    after(async () => {
        await pool.end();
    });

    const deps = () => ({ pool, client: harness.publicClient });

    const freshRecipient = (): Address => privateKeyToAccount(generatePrivateKey()).address;

    const deadlineIn = async (seconds: bigint): Promise<bigint> =>
        (await harness.publicClient.getBlock()).timestamp + seconds;

    /** What an owner's wallet does when asked to approve: sign the typed data. */
    const signAs = (owner: PrivateKeyAccount, proposal: Proposal): Promise<Hex> =>
        owner.signTypedData(
            executeTypedData(proposal.vault, proposal.chainId, {
                to: proposal.to,
                value: proposal.value,
                data: proposal.data,
                nonce: proposal.nonce,
                deadline: proposal.deadline,
            }),
        );

    const propose = async (to: Address, value: bigint) =>
        createProposal(deps(), { vault, to, value, data: "0x", deadline: await deadlineIn(3600n) });

    it("computes exactly the digest the vault verifies", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);

        const onChain = await harness.publicClient.readContract({
            address: vault,
            abi: vaultAbi,
            functionName: "hashExecute",
            args: [proposal.to, proposal.value, proposal.data, proposal.nonce, proposal.deadline],
        });

        // Computed independently from the typed-data definition. If these ever
        // disagreed, every signature collected would be rejected on submission.
        assert.equal(proposal.digest, onChain);
    });

    it("executes once three of five owners have signed, in any order", async () => {
        const recipient = freshRecipient();
        const proposal = await propose(recipient, 2n * ONE_ETHER);

        // Deliberately out of address order: the service must sort on submission.
        for (const owner of [owners[3]!, owners[0]!, owners[1]!]) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        const outcome = await submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id);

        assert.equal(outcome.kind, "executed");
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 2n * ONE_ETHER);

        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM vault_proposals WHERE id = $1",
            [proposal.id],
        );
        assert.equal(rows[0]?.status, "EXECUTED");
    });

    it("submits exactly the threshold even when more owners signed", async () => {
        const recipient = freshRecipient();
        const proposal = await propose(recipient, ONE_ETHER);
        for (const owner of owners) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        // The vault accepts exactly `threshold` signatures, no more.
        const outcome = await submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id);

        assert.equal(outcome.kind, "executed");
        assert.equal(await harness.publicClient.getBalance({ address: recipient }), ONE_ETHER);
    });

    it("moves an amount a BIGINT column could not hold", async () => {
        // Ten ether in wei is 10^19, past BIGINT's ceiling of about 9.22 * 10^18.
        const recipient = freshRecipient();
        const proposal = await propose(recipient, 10n * ONE_ETHER);
        for (const owner of owners.slice(0, 3)) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        await submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id);

        assert.equal(await harness.publicClient.getBalance({ address: recipient }), 10n * ONE_ETHER);
        const { rows } = await pool.query<{ value: string }>(
            "SELECT value FROM vault_proposals WHERE id = $1",
            [proposal.id],
        );
        assert.equal(rows[0]?.value, "10000000000000000000");
    });

    it("refuses a signature from someone who is not an owner", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);
        const outsider = privateKeyToAccount(generatePrivateKey());

        await assert.rejects(
            addSignature(deps(), proposal.id, await signAs(outsider, proposal)),
            NotAVaultOwner,
        );
    });

    it("refuses the same owner signing twice", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);
        const signature = await signAs(owners[0]!, proposal);

        await addSignature(deps(), proposal.id, signature);

        // Counting one owner twice is exactly how a 3-of-5 becomes a 1-of-5.
        await assert.rejects(addSignature(deps(), proposal.id, signature), DuplicateSignature);
    });

    it("refuses a malleated signature the vault would reject", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);
        const { r, s, yParity } = parseSignature(await signAs(owners[0]!, proposal));

        const twin = serializeSignature({
            r,
            s: `0x${(CURVE_N - BigInt(s)).toString(16).padStart(64, "0")}`,
            yParity: yParity === 0 ? 1 : 0,
        });

        // Recovers to the same owner off-chain, and would revert on-chain. Taking
        // it would make a proposal look ready when its submission cannot succeed.
        await assert.rejects(addSignature(deps(), proposal.id, twin), InvalidSignature);
    });

    it("refuses to submit before the quorum is reached", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);
        for (const owner of owners.slice(0, 2)) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        await assert.rejects(
            submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id),
            NotEnoughSignatures,
        );
    });

    it("keeps only one proposal collecting per vault nonce", async () => {
        await propose(freshRecipient(), ONE_ETHER);

        // Two proposals for one nonce race for the same slot; the loser's
        // signatures would be gathered for nothing.
        await assert.rejects(propose(freshRecipient(), ONE_ETHER), ProposalAlreadyOpen);
    });

    it("marks a proposal stale when the vault executed something else first", async () => {
        const proposal = await propose(freshRecipient(), ONE_ETHER);
        for (const owner of owners.slice(0, 3)) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        // Another approval for the same nonce, executed directly against the
        // vault by a different tool. The vault moves to nonce 1.
        const elsewhere = { ...proposal, to: freshRecipient(), value: 1n };
        const signatures = await Promise.all(owners.slice(0, 3).map((o) => signAs(o, elsewhere)));
        const account = submitter.walletClient.account!;
        const hash = await submitter.walletClient.writeContract({
            account,
            chain: null,
            address: vault,
            abi: vaultAbi,
            functionName: "execute",
            args: [elsewhere.to, elsewhere.value, "0x", elsewhere.deadline, signatures],
        });
        await harness.publicClient.waitForTransactionReceipt({ hash });

        await assert.rejects(
            submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id),
            ProposalStale,
        );

        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM vault_proposals WHERE id = $1",
            [proposal.id],
        );
        assert.equal(rows[0]?.status, "STALE");
    });

    it("rejects a deadline that has already passed on chain", async () => {
        await assert.rejects(
            createProposal(deps(), {
                vault,
                to: freshRecipient(),
                value: 1n,
                data: "0x",
                deadline: await deadlineIn(0n),
            }),
            DeadlineInPast,
        );
    });

    it("records expiry when the deadline passes after the quorum is reached", async () => {
        const proposal = await createProposal(deps(), {
            vault,
            to: freshRecipient(),
            value: 1n,
            data: "0x",
            deadline: await deadlineIn(60n),
        });
        for (const owner of owners.slice(0, 3)) {
            await addSignature(deps(), proposal.id, await signAs(owner, proposal));
        }

        await advanceChainTime(harness, 120);

        await assert.rejects(
            submitProposal({ ...deps(), wallet: submitter.walletClient }, proposal.id),
            ProposalExpired,
        );

        // The same trap as stale: raising the error inside the transaction used
        // to roll back the status change that recorded it.
        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM vault_proposals WHERE id = $1",
            [proposal.id],
        );
        assert.equal(rows[0]?.status, "EXPIRED");
    });

    it("expires a proposal whose deadline passes while collecting", async () => {
        const proposal = await createProposal(deps(), {
            vault,
            to: freshRecipient(),
            value: 1n,
            data: "0x",
            deadline: await deadlineIn(60n),
        });

        // Chain time, not wall-clock time: the vault only knows block.timestamp.
        await advanceChainTime(harness, 120);

        await assert.rejects(
            addSignature(deps(), proposal.id, await signAs(owners[0]!, proposal)),
            ProposalExpired,
        );

        const { rows } = await pool.query<{ status: string }>(
            "SELECT status FROM vault_proposals WHERE id = $1",
            [proposal.id],
        );
        assert.equal(rows[0]?.status, "EXPIRED");
    });
});
