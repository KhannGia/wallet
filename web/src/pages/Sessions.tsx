import { toSessionAccount } from "@wallet/shared";
import { useState } from "react";
import { encodeFunctionData, erc20Abi, isAddress, pad, parseAbiItem, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { bundler, paymaster, sendSponsored, smartAccount } from "../aa.ts";
import { graduatedAccount, type Config, type Graduation } from "../api.ts";
import { publicClient } from "../chain.ts";
import { accountAdminAbi, Operator, TRANSFER_SELECTOR } from "../contracts.ts";
import { errorMessage, parseUsdc, shortAddress, usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { loadOwner } from "../keys.ts";
import { keyFrom } from "../signing.ts";

interface SessionView {
    key: Address;
    active: boolean;
    validUntil: number;
    limit: bigint;
    spent: bigint;
}

/**
 * Session keys: a second key for an app or a bot, bounded in time, in what it
 * may call, and in how much it may move. The owner grants and revokes them; the
 * account enforces every bound on chain.
 */
export function Sessions({ accountId, config, graduations }: { accountId: string; config: Config; graduations: Graduation[] | undefined }) {
    const address = graduatedAccount(graduations)?.smartAccount as Address | undefined;
    const token = config.token.address as Address | null;
    const owner = loadOwner(accountId);
    const [hours, setHours] = useState("24");
    const [cap, setCap] = useState("50");
    const [onlyTo, setOnlyTo] = useState("");
    const [issued, setIssued] = useState<{ key: Hex; address: Address }>();
    const [useKey, setUseKey] = useState("");
    const [useTo, setUseTo] = useState("");
    const [useAmount, setUseAmount] = useState("");
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();

    const sessions = usePolling(
        async (): Promise<SessionView[]> => {
            if (!address || !token) return [];
            const added = await publicClient.getLogs({
                address,
                event: parseAbiItem("event SessionAdded(address indexed key, uint48 validAfter, uint48 validUntil)"),
                fromBlock: 0n,
            });
            const keys = [...new Set(added.map((log) => log.args.key!))];
            return Promise.all(
                keys.map(async (key) => {
                    const [active, , validUntil] = await publicClient.readContract({ address, abi: accountAdminAbi, functionName: "sessions", args: [key] });
                    const [, limit, spent] = await publicClient.readContract({
                        address,
                        abi: accountAdminAbi,
                        functionName: "tokenAllowances",
                        args: [key, token],
                    });
                    return { key, active, validUntil: Number(validUntil), limit, spent };
                }),
            );
        },
        3_000,
        [address, token],
    );

    if (!address || !token) {
        return (
            <main className="page narrow">
                <section className="card">
                    <h2>No smart account yet</h2>
                    <p>
                        Session keys act for a smart account. <a href="#/graduate">Graduate first</a>.
                    </p>
                </section>
            </main>
        );
    }

    async function run(label: string, action: () => Promise<string | void>) {
        setBusy(label);
        setError(undefined);
        setNotice(undefined);
        try {
            const message = await action();
            if (message) setNotice(message);
            await sessions.refresh();
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
                <p className="kicker">Session keys</p>
                <h1>A key with a leash.</h1>
                <p className="lede">
                    Give an app or a bot a key of its own: it may only send {config.token.symbol}, only until it expires,
                    and never more in total than you allow. Leaked, it costs at most that. You can revoke it any time.
                </p>
            </section>

            <section className="card reveal" aria-label="Grant a session">
                <h2>Grant one</h2>
                {!owner && <p className="error">This browser does not hold your owner key, so it cannot grant sessions.</p>}
                <label>
                    Valid for (hours)
                    <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
                </label>
                <label>
                    At most, in total ({config.token.symbol})
                    <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
                </label>
                <label>
                    Only to this address (optional)
                    <input value={onlyTo} onChange={(e) => setOnlyTo(e.target.value)} placeholder="0x… — leave empty for anyone" />
                </label>
                <button
                    className="primary"
                    disabled={!owner || busy !== undefined}
                    onClick={() =>
                        void run("grant", async () => {
                            const total = parseUsdc(cap);
                            const h = Number(hours);
                            if (!(Number.isInteger(h) && h >= 1 && h <= 24 * 30)) throw new Error("Between 1 hour and 30 days");
                            if (onlyTo.trim() && !isAddress(onlyTo.trim())) throw new Error("The recipient must be a 0x address");
                            const now = (await publicClient.getBlock()).timestamp;
                            const key = generatePrivateKey();
                            const session = privateKeyToAccount(key);
                            const conditions = onlyTo.trim()
                                ? [{ param: 0, operator: Operator.Equal, value: pad(onlyTo.trim() as Address) }]
                                : [];
                            await sendSponsored(await asOwner(), [
                                {
                                    to: address,
                                    data: encodeFunctionData({
                                        abi: accountAdminAbi,
                                        functionName: "addSession",
                                        args: [
                                            session.address,
                                            0,
                                            Number(now) + h * 3600,
                                            0n,
                                            [{ target: token, selector: TRANSFER_SELECTOR, conditions }],
                                            [{ token, limit: total }],
                                        ],
                                    }),
                                },
                            ]);
                            setIssued({ key, address: session.address });
                        })
                    }
                >
                    {busy === "grant" ? "Signing…" : "Grant a session key"}
                </button>
                {issued && (
                    <div className="issued" role="status">
                        <p>
                            Session <code>{shortAddress(issued.address)}</code> granted. Give this key to the app — it is
                            shown once and kept nowhere:
                        </p>
                        <code data-testid="session-key">{issued.key}</code>
                    </div>
                )}
            </section>

            <section className="card reveal" aria-label="Sessions">
                <h2>Sessions</h2>
                {sessions.data?.length === 0 && <p className="muted">None granted yet.</p>}
                <ol className="entries sessions">
                    {sessions.data?.map((s) => (
                        <li key={s.key} data-testid="session-row">
                            <code>{shortAddress(s.key)}</code>
                            <span className={s.active ? "credit" : "debit"}>{s.active ? "active" : "revoked"}</span>
                            <span className="running">
                                {usdc(s.spent)} / {usdc(s.limit)} used
                            </span>
                            {s.active && owner ? (
                                <button
                                    className="link"
                                    disabled={busy !== undefined}
                                    onClick={() =>
                                        void run("revoke", async () => {
                                            await sendSponsored(await asOwner(), [
                                                { to: address, data: encodeFunctionData({ abi: accountAdminAbi, functionName: "revokeSession", args: [s.key] }) },
                                            ]);
                                            return "Revoked. The key can do nothing from now on.";
                                        })
                                    }
                                >
                                    Revoke
                                </button>
                            ) : (
                                <span />
                            )}
                        </li>
                    ))}
                </ol>
            </section>

            <section className="card reveal" aria-label="Use a session key">
                <h2>Act as the app</h2>
                <p className="muted">What an app holding a session key does: send within its limits, gas paid by the platform.</p>
                <label>
                    Session key
                    <input type="password" value={useKey} onChange={(e) => setUseKey(e.target.value)} placeholder="0x…" />
                </label>
                <label>
                    Recipient address
                    <input value={useTo} onChange={(e) => setUseTo(e.target.value)} placeholder="0x…" />
                </label>
                <label>
                    Amount
                    <input inputMode="decimal" value={useAmount} onChange={(e) => setUseAmount(e.target.value)} />
                </label>
                <button
                    disabled={busy !== undefined}
                    onClick={() =>
                        void run("use", async () => {
                            const minor = parseUsdc(useAmount);
                            if (!isAddress(useTo.trim())) throw new Error("The recipient must be a 0x address");
                            const app = await toSessionAccount({
                                client: publicClient,
                                sessionKey: keyFrom(useKey),
                                account: address,
                                factory: config.accountFactory!,
                            });
                            const hash = await bundler.sendUserOperation({
                                account: app,
                                calls: [
                                    {
                                        to: token,
                                        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [useTo.trim() as Address, minor] }),
                                    },
                                ],
                                paymaster,
                            });
                            const receipt = await bundler.waitForUserOperationReceipt({ hash, pollingInterval: 1_000 });
                            if (!receipt.success) throw new Error("The account refused: over the session's limit");
                            return `Sent ${usdc(minor)} ${config.token.symbol} with the session key.`;
                        })
                    }
                >
                    {busy === "use" ? "Sending…" : "Send as the app"}
                </button>
            </section>

            {error && <p className="error" role="alert">{error}</p>}
            {notice && <p className="success" role="status">{notice}</p>}
        </main>
    );
}
