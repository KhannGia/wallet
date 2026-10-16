import { useState } from "react";
import { createWalletClient, encodeFunctionData, erc20Abi, http, isAddress, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";

import { api, type Config } from "../api.ts";
import { publicClient } from "../chain.ts";
import { errorMessage, parseUsdc, shortAddress, usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { keyFrom, signTypedJson, type TypedDataJson } from "../signing.ts";

interface Proposal {
    id: string;
    to: Address;
    value: string;
    data: Hex;
    status: string;
    threshold: number;
    collected: number;
    eta: string | null;
    transactionHash: string | null;
    failure: string | null;
    cancel: { to: Address; data: Hex } | null;
    typedData: TypedDataJson;
}

const ADMIN_KEY = "wallet.admin-token";

/** "transfer(0xabc…, 500)" for a token transfer; the raw call otherwise. */
function describe(p: Proposal, config: Config): string {
    if (config.token.address && p.to.toLowerCase() === config.token.address.toLowerCase() && p.data.startsWith("0xa9059cbb")) {
        const to = `0x${p.data.slice(34, 74)}` as Address;
        const amount = BigInt(`0x${p.data.slice(74, 138)}`);
        return `Send ${usdc(amount)} ${config.token.symbol} to ${shortAddress(to)}`;
    }
    return `Call ${shortAddress(p.to)} with ${p.value} wei`;
}

/**
 * The platform's reserves, from the operator's side: proposals opened with the
 * admin token, approved by the vault's owners -- each signing with their own
 * key -- and carried through the timelock by the submitter.
 */
export function Vault({ config }: { config: Config }) {
    const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(ADMIN_KEY) ?? "");
    const [to, setTo] = useState("");
    const [amount, setAmount] = useState("");
    const [ownerKey, setOwnerKey] = useState("");
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();

    const proposals = usePolling(() => api<Proposal[]>("/vault/proposals?limit=20"), 2_000);
    const now = usePolling(() => publicClient.getBlock().then((b) => b.timestamp), 2_000);

    if (!config.vault) return <main className="page narrow"><p className="card">No vault is deployed on this platform.</p></main>;

    async function run(label: string, action: () => Promise<string | void>) {
        setBusy(label);
        setError(undefined);
        setNotice(undefined);
        try {
            const message = await action();
            if (message) setNotice(message);
            await proposals.refresh();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setBusy(undefined);
        }
    }

    return (
        <main className="page">
            <section className="intro reveal">
                <p className="kicker">Reserves vault · operators</p>
                <h1>Nobody moves reserves alone.</h1>
                <p className="lede">
                    The vault at <code>{shortAddress(config.vault)}</code> pays out only what two of its three owners
                    approve. Anything but a small top-up of the hot wallet then waits out a timelock, during which any
                    single owner can cancel it.
                </p>
            </section>

            <section className="card reveal" aria-label="Propose">
                <h2>Propose</h2>
                <label>
                    Admin token
                    <input
                        type="password"
                        value={adminToken}
                        onChange={(e) => {
                            setAdminToken(e.target.value);
                            sessionStorage.setItem(ADMIN_KEY, e.target.value);
                        }}
                        placeholder="API_ADMIN_TOKEN"
                    />
                </label>
                <label>
                    Send {config.token.symbol} to
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" />
                </label>
                <label>
                    Amount
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <button
                    className="primary"
                    disabled={busy !== undefined}
                    onClick={() =>
                        void run("propose", async () => {
                            if (!isAddress(to.trim())) throw new Error("The recipient must be a 0x address");
                            const minor = parseUsdc(amount);
                            const deadline = (now.data ?? 0n) + 24n * 3600n;
                            const created = await api<Proposal>("/vault/proposals", {
                                token: adminToken,
                                body: {
                                    to: config.token.address,
                                    value: "0",
                                    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to.trim() as Address, minor] }),
                                    deadline: deadline.toString(),
                                },
                            });
                            setAmount("");
                            return `Proposal ${created.id} opened. It needs ${created.threshold} owners.`;
                        })
                    }
                >
                    {busy === "propose" ? "Opening…" : "Open a proposal"}
                </button>
            </section>

            <section className="card reveal" aria-label="Proposals">
                <h2>Proposals</h2>
                <label>
                    Your owner key, to sign or cancel
                    <input type="password" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)} placeholder="0x…" />
                    <small>On the demo, the owners are anvil's accounts 1 to 3; their keys are in anvil's banner.</small>
                </label>
                {proposals.data?.length === 0 && <p className="muted">Nothing proposed yet.</p>}
                <ol className="proposals">
                    {proposals.data?.map((p) => (
                        <li key={p.id} data-testid={`proposal-${p.id}`}>
                            <div>
                                <b>#{p.id}</b> {describe(p, config)}
                            </div>
                            <div className="proposal-state" data-testid={`proposal-${p.id}-status`}>
                                {p.status === "COLLECTING"
                                    ? `collecting · ${p.collected}/${p.threshold}`
                                    : p.status === "QUEUED"
                                      ? `queued · ${p.eta && now.data !== undefined && BigInt(p.eta) > now.data ? `${(BigInt(p.eta) - now.data).toString()}s left` : "due"}`
                                      : p.status.toLowerCase()}
                                {p.failure && <span className="error"> · {p.failure}</span>}
                            </div>
                            <div className="proposal-actions">
                                {p.status === "COLLECTING" && (
                                    <button
                                        disabled={busy !== undefined}
                                        onClick={() =>
                                            void run(`sign-${p.id}`, async () => {
                                                const owner = keyFrom(ownerKey);
                                                const signature = await signTypedJson(owner, p.typedData);
                                                await api(`/vault/proposals/${p.id}/signatures`, { body: { signature } });
                                                return `Signed #${p.id} as ${shortAddress(owner.address)}.`;
                                            })
                                        }
                                    >
                                        Sign
                                    </button>
                                )}
                                {p.status === "QUEUED" && p.cancel && (
                                    <button
                                        disabled={busy !== undefined}
                                        onClick={() =>
                                            void run(`cancel-${p.id}`, async () => {
                                                // An owner's own transaction: the vault takes a cancel from any
                                                // single owner, and the API holds no owner key to send it.
                                                const owner = keyFrom(ownerKey);
                                                const wallet = createWalletClient({ account: owner, chain: foundry, transport: http("/chain") });
                                                const hash = await wallet.sendTransaction({ to: p.cancel!.to, data: p.cancel!.data });
                                                await publicClient.waitForTransactionReceipt({ hash });
                                                return `Cancelled #${p.id}.`;
                                            })
                                        }
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
            </section>

            {error && <p className="error" role="alert">{error}</p>}
            {notice && <p className="success" role="status">{notice}</p>}
        </main>
    );
}
