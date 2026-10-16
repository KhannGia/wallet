import { useState } from "react";

import { api } from "../api.ts";
import { shortAddress } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { keyFrom, signTypedJson, type TypedDataJson } from "../signing.ts";

interface Request {
    id: string;
    account: string;
    newOwner: string;
    status: string;
    threshold: number;
    deadline: string;
    executableAt: string | null;
    approvals: { guardian: string }[];
    approvalTypedData: TypedDataJson;
}

/**
 * A guardian's view of a recovery request: what they are being asked to
 * approve, and a place to sign it. No sign-in -- a guardian need not be a user
 * here at all. Their signature is the only thing that counts, and the guardian
 * module checks it again on chain.
 */
export function Guard({ id }: { id: string }) {
    const request = usePolling(() => api<Request>(`/recovery/requests/${id}`), 2_000, [id]);
    const [key, setKey] = useState("");
    const [error, setError] = useState<string>();
    const [done, setDone] = useState<string>();

    const r = request.data;
    return (
        <main className="auth guard">
            <section className="auth-pitch reveal">
                <p className="kicker">Guardian approval</p>
                <h1>Someone you vouch for has lost their key.</h1>
                <p className="lede">
                    Approve only if you have confirmed it is really them — by phone, in person. Once enough guardians
                    approve, their account passes to the new key after 48 hours, unless the old key stops it.
                </p>
            </section>
            <section className="card reveal">
                {request.error && <p className="error">{request.error}</p>}
                {r && (
                    <>
                        <dl className="facts-list">
                            <dt>Account</dt>
                            <dd>
                                <code>{r.account}</code>
                            </dd>
                            <dt>Hand it to</dt>
                            <dd>
                                <code>{r.newOwner}</code>
                            </dd>
                            <dt>Status</dt>
                            <dd data-testid="guard-status">{r.status}</dd>
                            <dt>Approvals</dt>
                            <dd data-testid="guard-approvals">
                                {r.approvals.length} of {r.threshold}
                            </dd>
                        </dl>
                        {r.status === "COLLECTING" && (
                            <div className="stack">
                                <label>
                                    Your guardian key
                                    <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="0x…" />
                                    <small>A demo stand-in for your own wallet: the key signs here and is not sent anywhere.</small>
                                </label>
                                <button
                                    className="primary"
                                    onClick={() =>
                                        void (async () => {
                                            setError(undefined);
                                            try {
                                                const guardian = keyFrom(key);
                                                const signature = await signTypedJson(guardian, r.approvalTypedData);
                                                await api(`/recovery/requests/${id}/approvals`, { body: { signature } });
                                                setDone(`Approved as ${shortAddress(guardian.address)}.`);
                                                setKey("");
                                                await request.refresh();
                                            } catch (caught) {
                                                setError((caught as Error).message);
                                            }
                                        })()
                                    }
                                >
                                    Approve the recovery
                                </button>
                            </div>
                        )}
                        {error && <p className="error" role="alert">{error}</p>}
                        {done && <p className="success" role="status">{done}</p>}
                    </>
                )}
            </section>
        </main>
    );
}
