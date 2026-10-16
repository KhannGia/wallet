import { useState } from "react";
import type { Address } from "viem";

import { api, type Account, type Config, type Entry } from "../api.ts";
import { faucet, isDevnet } from "../chain.ts";
import { usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";

const KIND: Record<string, string> = {
    DEPOSIT: "Deposit",
    TRANSFER: "Transfer",
    PAYOUT: "Payout",
    GRADUATION: "Graduation",
    REVERSAL: "Returned",
    WITHDRAWAL: "Withdrawal",
};

/** The account at a glance: what can be spent, what is on its way in or out, and every movement. */
export function Dashboard({ accountId, config }: { accountId: string; config: Config }) {
    const account = usePolling(() => api<Account>(`/accounts/${accountId}`), 2_000, [accountId]);
    const entries = usePolling(
        () => api<{ entries: Entry[]; nextCursor: string | null }>(`/accounts/${accountId}/entries?limit=20`),
        4_000,
        [accountId],
    );
    const [copied, setCopied] = useState(false);
    const [minting, setMinting] = useState(false);

    const a = account.data;
    const depositAddress = a?.depositAddress as Address | undefined;

    async function mint() {
        if (!config.token.address || !depositAddress) return;
        setMinting(true);
        try {
            await faucet(config.token.address, depositAddress, 100_000_000n);
        } finally {
            setMinting(false);
        }
    }

    return (
        <main className="page">
            <section className="balances reveal" aria-label="Balances">
                <div className="figure hero">
                    <span className="label">Available</span>
                    <span className="amount" data-testid="balance">
                        {a ? usdc(a.balance) : "—"}
                    </span>
                    <span className="unit">{config.token.symbol}</span>
                </div>
                <div className="figure">
                    <span className="label">Arriving</span>
                    <span className="amount small" data-testid="pending">
                        {a ? usdc(a.pendingBalance) : "—"}
                    </span>
                    <span className="note">seen on chain, waiting to be final</span>
                </div>
                <div className="figure">
                    <span className="label">Leaving</span>
                    <span className="amount small" data-testid="reserved">
                        {a ? usdc(a.reservedBalance) : "—"}
                    </span>
                    <span className="note">set aside for payouts in flight</span>
                </div>
            </section>

            <section className="card deposit reveal" aria-label="Deposit">
                <h2>Deposit</h2>
                <p>
                    Send {config.token.symbol} on chain to your own address. It shows as arriving at once, and
                    becomes available when its block is final.
                </p>
                <div className="address-row">
                    <code data-testid="deposit-address">{depositAddress ?? "…"}</code>
                    <button
                        type="button"
                        onClick={() => {
                            if (!depositAddress) return;
                            void navigator.clipboard?.writeText(depositAddress);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }}
                    >
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
                {isDevnet(config.chainId) && (
                    <button type="button" className="ghost" disabled={minting || !depositAddress} onClick={() => void mint()}>
                        {minting ? "Minting…" : `Devnet faucet: send me 100 ${config.token.symbol}`}
                    </button>
                )}
            </section>

            <section className="card ledger reveal" aria-label="History">
                <h2>Ledger</h2>
                {entries.data && entries.data.entries.length === 0 && <p className="muted">Nothing yet.</p>}
                <ol className="entries">
                    {entries.data?.entries.map((entry, index) => (
                        <li key={entry.id} style={{ animationDelay: `${index * 30}ms` }}>
                            <time>{new Date(entry.createdAt).toLocaleString()}</time>
                            <span className="tx">{KIND[entry.kind] ?? entry.kind}</span>
                            <span className={BigInt(entry.amount) < 0n ? "debit" : "credit"}>
                                {BigInt(entry.amount) > 0n ? "+" : ""}
                                {usdc(entry.amount)}
                            </span>
                            <span className="running">{usdc(entry.balanceAfter)}</span>
                        </li>
                    ))}
                </ol>
            </section>
        </main>
    );
}
