import { hashLeaf, hashNode, reservesRegistryAbi, sumProofFromJson, verifyAgainstRegistry, type SumNode, type Verdict } from "@wallet/shared";
import { useState } from "react";

import { api, ApiError, type Config } from "../api.ts";
import { publicClient } from "../chain.ts";
import { shortAddress, usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";

interface LatestSnapshot {
    id: string;
    blockNumber: string;
    assets: string;
    liabilities: string;
    surplus: string;
    solvent: boolean;
    rootHash: string | null;
}

interface ProofDocument {
    snapshotId: string;
    proof: unknown;
}

/** One line of the walk from a user's leaf to the root. */
interface Line {
    label: string;
    side?: "left" | "right";
    sibling?: SumNode;
    node: SumNode;
}

function walk(document: ProofDocument): Line[] {
    const proof = sumProofFromJson(document.proof);
    let node = hashLeaf(proof.leaf);
    const lines: Line[] = [{ label: "Your leaf: your balance, sealed with a salt only you were given", node }];
    proof.path.forEach((step, index) => {
        const sibling = { hash: step.hash, sum: step.sum };
        node = step.side === "left" ? hashNode(sibling, node) : hashNode(node, sibling);
        lines.push({ label: `Level ${index + 1}: combined with the branch on the ${step.side}`, side: step.side, sibling, node });
    });
    return lines;
}

/**
 * Proof of reserves, checked by the user's own browser. The attestation is
 * read from the registry contract; the proof comes from our API, but nothing
 * the API says about the root is used -- the browser computes the root from
 * the proof and looks that up on chain.
 */
export function Reserves({ accountId, config }: { accountId: string; config: Config }) {
    const registry = config.reservesRegistry;
    const latest = usePolling(() => api<LatestSnapshot>("/reserves/latest").catch(() => undefined), 5_000);
    const onChain = usePolling(
        async () => {
            if (!registry) return undefined;
            const count = await publicClient.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "count" });
            if (count === 0n) return null;
            const [id, attestation] = await publicClient.readContract({ address: registry, abi: reservesRegistryAbi, functionName: "latest" });
            return { id, ...attestation };
        },
        5_000,
        [registry],
    );
    const [lines, setLines] = useState<Line[]>();
    const [verdict, setVerdict] = useState<Verdict>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    async function verify() {
        if (!registry || !latest.data) return;
        setBusy(true);
        setError(undefined);
        setVerdict(undefined);
        setLines(undefined);
        try {
            const document = await api<ProofDocument>(`/reserves/${latest.data.id}/proof/${accountId}`);
            setLines(walk(document));
            setVerdict(await verifyAgainstRegistry(publicClient, registry, document));
        } catch (caught) {
            setError(
                caught instanceof ApiError && caught.code === "not_in_snapshot"
                    ? "Your account is newer than the latest snapshot. The next one includes it — a few seconds on this demo."
                    : (caught as Error).message,
            );
        } finally {
            setBusy(false);
        }
    }

    const a = onChain.data;
    return (
        <main className="page">
            <section className="intro reveal">
                <p className="kicker">Proof of reserves</p>
                <h1>Don't trust us. Check.</h1>
                <p className="lede">
                    Every few minutes we add up what we owe every user, compare it with what we hold on chain, and
                    publish the result to a contract nobody can edit — not us either. Then you check that your own
                    balance is inside the total, with nothing but your proof and the chain.
                </p>
            </section>

            {!registry ? (
                <p className="card">No reserves registry is deployed on this platform.</p>
            ) : a === null || a === undefined ? (
                <p className="card muted">Nothing published yet.</p>
            ) : (
                <section className="balances reveal" aria-label="Latest attestation">
                    <div className="figure hero">
                        <span className="label">Held on chain</span>
                        <span className="amount" data-testid="assets">
                            {usdc(a.assets)}
                        </span>
                        <span className="unit">
                            {config.token.symbol} · hot wallet, vault, deposit addresses
                        </span>
                    </div>
                    <div className="figure">
                        <span className="label">Owed to users</span>
                        <span className="amount small" data-testid="liabilities">
                            {usdc(a.liabilities)}
                        </span>
                        <span className="note">the root's total</span>
                    </div>
                    <div className="figure">
                        <span className="label">Verdict</span>
                        <span className={`amount small ${a.assets >= a.liabilities ? "credit" : "debit"}`} data-testid="solvent">
                            {a.assets >= a.liabilities ? "Covered" : "Short"}
                        </span>
                        <span className="note">
                            attestation #{a.id.toString()} · block {a.blockNumber.toString()}
                        </span>
                    </div>
                </section>
            )}

            <section className="card reveal" aria-label="Verify my balance">
                <h2>Is my balance in there?</h2>
                <p>
                    Your browser fetches your proof, walks it up the tree adding every branch's total, and looks the
                    root it arrives at up in the registry contract at <code>{registry ? shortAddress(registry) : "—"}</code>.
                </p>
                <button className="primary" disabled={busy || !latest.data || !registry} onClick={() => void verify()}>
                    {busy ? "Checking…" : "Check my balance"}
                </button>
                {error && <p className="error" role="alert">{error}</p>}

                {lines && (
                    <ol className="walk" aria-label="Proof">
                        {lines.map((line, index) => (
                            <li key={index} style={{ animationDelay: `${index * 160}ms` }}>
                                <span className="walk-label">{line.label}</span>
                                {line.sibling ? (
                                    <span className="walk-sibling">
                                        + {usdc(line.sibling.sum)} <code>{line.sibling.hash.slice(0, 10)}…</code>
                                    </span>
                                ) : (
                                    <span />
                                )}
                                <span className="walk-node">
                                    = {usdc(line.node.sum)} <code>{line.node.hash.slice(0, 10)}…</code>
                                </span>
                            </li>
                        ))}
                    </ol>
                )}

                {verdict && (
                    <div className={`verdict ${verdict.valid ? "ok" : "bad"}`} role="status" data-testid="verdict" style={{ animationDelay: `${(lines?.length ?? 0) * 160}ms` }}>
                        {verdict.valid ? (
                            <>
                                <strong>Verified.</strong> {usdc(verdict.amount)} {config.token.symbol} owed to account {verdict.accountId.toString()} is inside attestation #
                                {verdict.attestationId.toString()}, whose total of {usdc(verdict.liabilities)} is on chain at block {verdict.blockNumber.toString()}.
                            </>
                        ) : (
                            <>
                                <strong>Not verified.</strong> {verdict.reason}
                            </>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
}
