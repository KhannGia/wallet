import { useState } from "react";
import { encodeFunctionData, getAddress, isAddress, type Address } from "viem";

import { sendSponsored, smartAccount } from "../aa.ts";
import { api, graduatedAccount, type Config, type Graduation } from "../api.ts";
import { publicClient } from "../chain.ts";
import { guardianModuleAbi } from "../contracts.ts";
import { errorMessage, shortAddress } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { createOwner, loadOwner } from "../keys.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const recoveryKey = (accountId: string) => `wallet.recovery.${accountId}`;

interface RecoveryRequest {
    id: string;
    status: string;
    threshold: number;
    executableAt: string | null;
    newOwner: string;
    approvals?: unknown[];
}

/**
 * Guardians: who may hand the account to a new key if the owner loses theirs.
 * The owner changes them, and vetoes a recovery they did not ask for; a user
 * who has lost the key asks their guardians from here.
 */
export function Guardians({ accountId, config, graduations }: { accountId: string; config: Config; graduations: Graduation[] | undefined }) {
    const address = graduatedAccount(graduations)?.smartAccount as Address | undefined;
    const module = config.guardianModule as Address | null;
    const [owner, setOwner] = useState(() => loadOwner(accountId));
    const [list, setList] = useState("");
    const [threshold, setThreshold] = useState("1");
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [requestId, setRequestId] = useState(() => localStorage.getItem(recoveryKey(accountId)));

    const chain = usePolling(
        async () => {
            if (!address || !module) return undefined;
            const [guardians, required, [pendingOwner, executableAt], currentOwner, now] = await Promise.all([
                publicClient.readContract({ address: module, abi: guardianModuleAbi, functionName: "guardians", args: [address] }),
                publicClient.readContract({ address: module, abi: guardianModuleAbi, functionName: "threshold", args: [address] }),
                publicClient.readContract({ address: module, abi: guardianModuleAbi, functionName: "pending", args: [address] }),
                publicClient.readContract({
                    address,
                    abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const,
                    functionName: "owner",
                }),
                publicClient.getBlock().then((block) => block.timestamp),
            ]);
            return { guardians, required, pendingOwner, executableAt, currentOwner, now };
        },
        2_000,
        [address, module],
    );
    const request = usePolling(
        () => (requestId ? api<RecoveryRequest>(`/recovery/requests/${requestId}`) : Promise.resolve(undefined)),
        2_000,
        [requestId],
    );

    if (!address || !module) {
        return (
            <main className="page narrow">
                <section className="card">
                    <h2>No smart account yet</h2>
                    <p>
                        Guardians protect a smart account. <a href="#/graduate">Graduate first</a>.
                    </p>
                </section>
            </main>
        );
    }

    const c = chain.data;
    const holdsKey = owner && c && owner.address.toLowerCase() === c.currentOwner.toLowerCase();
    const pending = c && c.pendingOwner !== ZERO;

    async function run(label: string, action: () => Promise<string | void>) {
        setBusy(label);
        setError(undefined);
        setNotice(undefined);
        try {
            const message = await action();
            if (message) setNotice(message);
            await chain.refresh();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setBusy(undefined);
        }
    }

    const asOwner = () => smartAccount(owner!, config.accountFactory!, address);

    return (
        <main className="page">
            <section className="intro reveal">
                <p className="kicker">Guardians</p>
                <h1>If you lose the key.</h1>
                <p className="lede">
                    People you trust — or another device of yours — who can together hand your account to a new key.
                    Never at once: a recovery waits 48 hours, and you can stop it with the key you still hold.
                </p>
            </section>

            {pending && (
                <section className="card alarm reveal" role="alert" data-testid="pending-recovery">
                    <h2>A recovery is under way</h2>
                    <p>
                        Your guardians have agreed to hand this account to <code>{c.pendingOwner}</code>. It can be completed
                        {c.executableAt > c.now
                            ? ` in ${Math.ceil(Number(c.executableAt - c.now) / 3600)} hours.`
                            : " now."}
                    </p>
                    {holdsKey ? (
                        <>
                            <p>If this was not you, stop it. Your key is in this browser.</p>
                            <button
                                className="primary"
                                disabled={busy !== undefined}
                                onClick={() =>
                                    void run("veto", async () => {
                                        await sendSponsored(await asOwner(), [
                                            { to: module, data: encodeFunctionData({ abi: guardianModuleAbi, functionName: "cancelRecovery" }) },
                                        ]);
                                        return "Recovery stopped. The account still answers to your key.";
                                    })
                                }
                            >
                                {busy === "veto" ? "Stopping…" : "This was not me — stop it"}
                            </button>
                        </>
                    ) : (
                        <p className="muted">This browser does not hold the current key, so it cannot stop it.</p>
                    )}
                </section>
            )}

            <section className="card reveal" aria-label="Your guardians">
                <h2>Your guardians</h2>
                {c && c.guardians.length === 0 && <p className="muted">None yet. Without guardians, a lost key is a lost account.</p>}
                {c && c.guardians.length > 0 && (
                    <>
                        <ol className="plain" data-testid="guardian-list">
                            {c.guardians.map((g) => (
                                <li key={g}>
                                    <code>{g}</code>
                                </li>
                            ))}
                        </ol>
                        <p>
                            <b data-testid="guardian-threshold">{c.required.toString()}</b> of {c.guardians.length} must agree.
                        </p>
                    </>
                )}

                {holdsKey && (
                    <div className="stack">
                        <label>
                            New guardians (one address per line)
                            <textarea rows={3} value={list} onChange={(e) => setList(e.target.value)} />
                        </label>
                        <label>
                            How many must agree
                            <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                        </label>
                        <button
                            disabled={busy !== undefined}
                            onClick={() =>
                                void run("set", async () => {
                                    const entries = list.split(/\s+/).filter(Boolean);
                                    if (entries.length === 0 || entries.some((g) => !isAddress(g))) throw new Error("List at least one 0x address");
                                    const unique = [...new Set(entries.map((g) => getAddress(g)))];
                                    const n = Number(threshold);
                                    if (!(Number.isInteger(n) && n >= 1 && n <= unique.length)) throw new Error(`Between 1 and ${unique.length} must agree`);
                                    await sendSponsored(await asOwner(), [
                                        {
                                            to: module,
                                            data: encodeFunctionData({ abi: guardianModuleAbi, functionName: "setGuardians", args: [unique, BigInt(n)] }),
                                        },
                                    ]);
                                    setList("");
                                    return "Guardians replaced.";
                                })
                            }
                        >
                            {busy === "set" ? "Signing…" : "Replace guardians"}
                        </button>
                    </div>
                )}
            </section>

            {!holdsKey && c && (
                <section className="card reveal" aria-label="Lost key">
                    <h2>Lost your key?</h2>
                    {!requestId ? (
                        <div className="stack">
                            <p>
                                This browser makes a new key. Your guardians approve handing the account to it; after 48
                                hours it is yours, and the old key is worthless.
                            </p>
                            <button
                                className="primary"
                                disabled={busy !== undefined || c.guardians.length === 0}
                                onClick={() =>
                                    void run("recover", async () => {
                                        const fresh = owner ?? createOwner(accountId);
                                        setOwner(fresh);
                                        const deadline = c.now + 7n * 24n * 3600n;
                                        const opened = await api<RecoveryRequest>("/recovery/requests", {
                                            body: { account: address, newOwner: fresh.address, deadline: deadline.toString() },
                                        });
                                        localStorage.setItem(recoveryKey(accountId), opened.id);
                                        setRequestId(opened.id);
                                    })
                                }
                            >
                                {busy === "recover" ? "Asking…" : "Ask my guardians"}
                            </button>
                            {c.guardians.length === 0 && <p className="error">There are no guardians to ask.</p>}
                        </div>
                    ) : (
                        <div className="stack" data-testid="recovery-request">
                            <p>
                                Send each guardian this link. They approve with their own key:
                                <br />
                                <code data-testid="guardian-link">
                                    {window.location.origin}/#/guard/{requestId}
                                </code>
                            </p>
                            {request.data && (
                                <p>
                                    Request <b>{request.data.id}</b>: <b data-testid="recovery-status">{request.data.status}</b> —{" "}
                                    {request.data.approvals?.length ?? 0} of {request.data.threshold} approvals
                                    {request.data.executableAt ? `, completes after block time ${request.data.executableAt}` : ""}. New key{" "}
                                    {shortAddress(request.data.newOwner)}.
                                </p>
                            )}
                        </div>
                    )}
                </section>
            )}

            {error && <p className="error" role="alert">{error}</p>}
            {notice && <p className="success" role="status">{notice}</p>}
        </main>
    );
}
