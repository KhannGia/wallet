import { useEffect, useState } from "react";
import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import { isDeployed, sendSponsored, smartAccount } from "../aa.ts";
import { api, type Account, type Config, type Graduation } from "../api.ts";
import { errorMessage, shortAddress, usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { createOwner, downloadBackup, importOwner, isBackedUp, loadOwner, markBackedUp } from "../keys.ts";

const setupAbi = parseAbi([
    "function setRecoveryModule(address module)",
    "function setGuardians(address[] guardians, uint256 threshold)",
]);

type StepState = "done" | "now" | "later";

function Step(props: { n: string; title: string; state: StepState; children?: React.ReactNode }) {
    return (
        <li className={`step ${props.state}`} aria-current={props.state === "now" ? "step" : undefined}>
            <span className="step-n">{props.n}</span>
            <div className="step-body">
                <h3>{props.title}</h3>
                {props.state === "now" && props.children}
                {props.state === "done" && <p className="muted">Done.</p>}
            </div>
        </li>
    );
}

/**
 * Leaving custody, in four steps the user takes themselves: a key only this
 * browser holds, a graduation opened for it, the account deployed -- guardians
 * named in the same operation, the platform paying the gas -- and then the
 * whole balance moved to it.
 */
export function Graduate({ accountId, config, onGraduated }: { accountId: string; config: Config; onGraduated: () => void }) {
    const [owner, setOwner] = useState<PrivateKeyAccount | null>(() => loadOwner(accountId));
    const [backedUp, setBackedUp] = useState(() => isBackedUp(accountId));
    const graduations = usePolling(() => api<Graduation[]>(`/accounts/${accountId}/graduations`), 2_000, [accountId]);
    const account = usePolling(() => api<Account>(`/accounts/${accountId}`), 3_000, [accountId]);
    const [deployed, setDeployed] = useState<boolean>();
    const [guardians, setGuardians] = useState("");
    const [threshold, setThreshold] = useState("1");
    const [importing, setImporting] = useState("");
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();

    const latest = graduations.data?.[0];
    const open = latest && (latest.status === "AWAITING_ACTIVATION" || latest.status === "FUNDING") ? latest : undefined;
    const completed = latest?.status === "COMPLETED" ? latest : undefined;

    useEffect(() => {
        if (open === undefined) return setDeployed(undefined);
        let live = true;
        const check = () => void isDeployed(open.smartAccount).then((d) => live && setDeployed(d));
        check();
        const timer = window.setInterval(check, 2_000);
        return () => {
            live = false;
            window.clearInterval(timer);
        };
    }, [open?.smartAccount]);

    useEffect(() => {
        if (completed) onGraduated();
    }, [completed?.id]);

    async function run(label: string, action: () => Promise<void>) {
        setBusy(label);
        setError(undefined);
        try {
            await action();
            await graduations.refresh();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setBusy(undefined);
        }
    }

    const notConfigured = !config.accountFactory || !config.guardianModule || !config.paymaster;
    if (notConfigured) {
        return (
            <main className="page narrow">
                <p className="card">Self-custody is not set up on this platform: no account factory, paymaster or guardian module.</p>
            </main>
        );
    }

    const keyStep: StepState = owner && backedUp ? "done" : "now";
    const openStep: StepState = keyStep !== "done" ? "later" : open ? "done" : "now";
    const activateStep: StepState = openStep !== "done" ? "later" : deployed ? "done" : "now";
    const fundStep: StepState = activateStep !== "done" ? "later" : open?.status === "FUNDING" ? "now" : "now";
    const ownerMismatch = open && owner && open.owner.toLowerCase() !== owner.address.toLowerCase();

    return (
        <main className="page">
            <section className="intro reveal">
                <p className="kicker">Self-custody</p>
                <h1>Take your balance with you.</h1>
                <p className="lede">
                    Your money moves to a smart account that answers to a key only you hold. We cannot move it, and
                    we cannot freeze it. If you lose the key, the guardians you name can hand the account to a new
                    one — after 48 hours, during which you can stop them.
                </p>
            </section>

            {completed && !open && (
                <section className="card success-card reveal" data-testid="graduated">
                    <h2>Graduated</h2>
                    <p>
                        {usdc(completed.amount ?? "0")} {config.token.symbol} moved to your smart account{" "}
                        <code>{completed.smartAccount}</code>. It is yours now.
                    </p>
                    <p>
                        <a href="#/smart">Open your smart account →</a>
                    </p>
                    {account.data && BigInt(account.data.balance) > 0n && (
                        <p className="muted">
                            {usdc(account.data.balance)} {config.token.symbol} has arrived in custody since; you can move it
                            too, below.
                        </p>
                    )}
                </section>
            )}

            <ol className="steps card reveal">
                <Step n="I" title="A key only you hold" state={keyStep}>
                    {!owner ? (
                        <div className="stack">
                            <p>It is made in this browser and never leaves it. Not even we see it.</p>
                            <button className="primary" onClick={() => setOwner(createOwner(accountId))}>
                                Make my key
                            </button>
                            <details>
                                <summary>I already have one</summary>
                                <label>
                                    Private key
                                    <input value={importing} onChange={(e) => setImporting(e.target.value)} placeholder="0x…" />
                                </label>
                                <button
                                    onClick={() => {
                                        try {
                                            setOwner(importOwner(accountId, importing));
                                            setBackedUp(true);
                                            setImporting("");
                                        } catch (caught) {
                                            setError((caught as Error).message);
                                        }
                                    }}
                                >
                                    Use this key
                                </button>
                            </details>
                        </div>
                    ) : (
                        <div className="stack">
                            <p>
                                Your key's address is <code data-testid="owner-address">{owner.address}</code>. Save a
                                copy now: it exists only in this browser.
                            </p>
                            <button onClick={() => downloadBackup(accountId)}>Download a backup</button>
                            <button
                                className="primary"
                                onClick={() => {
                                    markBackedUp(accountId);
                                    setBackedUp(true);
                                }}
                            >
                                I have saved it somewhere safe
                            </button>
                        </div>
                    )}
                </Step>

                <Step n="II" title="Your account's address" state={openStep}>
                    <div className="stack">
                        <p>
                            Fixed by your key before it exists. Nothing is moved yet
                            {account.data ? ` — ${usdc(account.data.balance)} ${config.token.symbol} will go.` : "."}
                        </p>
                        <button
                            className="primary"
                            disabled={busy !== undefined || !owner}
                            onClick={() =>
                                void run("open", () =>
                                    api(`/accounts/${accountId}/graduation`, { body: { owner: owner!.address } }).then(() => undefined),
                                )
                            }
                        >
                            {busy === "open" ? "Opening…" : completed ? "Graduate my new balance" : "Start"}
                        </button>
                    </div>
                </Step>

                <Step n="III" title="Bring it to life — and name guardians" state={activateStep}>
                    {ownerMismatch ? (
                        <div className="stack">
                            <p className="error">
                                This graduation was opened for key {shortAddress(open!.owner)}, which this browser does
                                not hold. Import that key above, or start over.
                            </p>
                            <button onClick={() => void run("cancel", () => api(`/graduations/${open!.id}/cancellation`, { method: "POST" }).then(() => undefined))}>
                                Start over
                            </button>
                        </div>
                    ) : (
                        <div className="stack">
                            <p>
                                Your account <code data-testid="smart-account">{open?.smartAccount}</code> is deployed by an
                                operation you sign here. We pay its gas. Name guardians now — friends, another device —
                                so a lost key is not the end. You can skip it and add them later.
                            </p>
                            <label>
                                Guardians (one address per line, optional)
                                <textarea rows={3} value={guardians} onChange={(e) => setGuardians(e.target.value)} placeholder="0x…" />
                            </label>
                            <label>
                                How many must agree to recover
                                <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                            </label>
                            <button
                                className="primary"
                                disabled={busy !== undefined}
                                onClick={() =>
                                    void run("activate", async () => {
                                        const list = guardians.split(/\s+/).filter(Boolean);
                                        if (list.some((g) => !isAddress(g))) throw new Error("Every guardian must be a 0x address");
                                        const unique = [...new Set(list.map((g) => getAddress(g)))];
                                        const n = Number(threshold);
                                        if (unique.length > 0 && !(Number.isInteger(n) && n >= 1 && n <= unique.length)) {
                                            throw new Error(`The number who must agree is between 1 and ${unique.length}`);
                                        }
                                        const account = await smartAccount(owner!, config.accountFactory!);
                                        const module = config.guardianModule as Address;
                                        await sendSponsored(account, [
                                            {
                                                to: account.address,
                                                data: encodeFunctionData({ abi: setupAbi, functionName: "setRecoveryModule", args: [module] }),
                                            },
                                            ...(unique.length > 0
                                                ? [
                                                      {
                                                          to: module,
                                                          data: encodeFunctionData({
                                                              abi: setupAbi,
                                                              functionName: "setGuardians",
                                                              args: [unique, BigInt(n)],
                                                          }),
                                                      },
                                                  ]
                                                : []),
                                        ]);
                                        setDeployed(true);
                                    })
                                }
                            >
                                {busy === "activate" ? "Signing and sending…" : "Sign and deploy"}
                            </button>
                        </div>
                    )}
                </Step>

                <Step n="IV" title="Move the balance" state={activateStep === "done" ? fundStep : "later"}>
                    {open?.status === "FUNDING" ? (
                        <p data-testid="funding">
                            {usdc(open.amount ?? "0")} {config.token.symbol} is on its way from our hot wallet. This takes a
                            block or two.
                        </p>
                    ) : (
                        <div className="stack">
                            <p>The whole available balance leaves custody for the account you just deployed.</p>
                            <button
                                className="primary"
                                disabled={busy !== undefined}
                                onClick={() =>
                                    void run("fund", () => api(`/graduations/${open!.id}/funding`, { method: "POST" }).then(() => undefined))
                                }
                            >
                                {busy === "fund" ? "Moving…" : "Move my balance"}
                            </button>
                        </div>
                    )}
                </Step>
            </ol>

            {latest?.status === "FAILED" && (
                <p className="card error" role="alert">
                    The last transfer failed ({latest.failure}). Your balance is back in custody; you can try again.
                </p>
            )}
            {error && (
                <p className="error" role="alert">
                    {error}
                </p>
            )}
        </main>
    );
}
