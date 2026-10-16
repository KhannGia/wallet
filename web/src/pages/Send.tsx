import { useState, type FormEvent } from "react";
import { isAddress } from "viem";

import { api, ApiError } from "../api.ts";
import { parseUsdc, usdc } from "../format.ts";
import { useIdempotencyKey } from "../hooks.ts";

/**
 * Two ways out of an account: to another user, inside the ledger -- free and
 * instant -- or to any address on chain, through the withdrawal worker.
 */
export function Send({ accountId }: { accountId: string }) {
    const [mode, setMode] = useState<"user" | "chain">("user");
    const [to, setTo] = useState("");
    const [amount, setAmount] = useState("");
    const [key, nextKey] = useIdempotencyKey();
    const [result, setResult] = useState<string>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setError(undefined);
        setResult(undefined);
        let minor: bigint;
        try {
            minor = parseUsdc(amount);
            if (mode === "user" && !/^[1-9]\d*$/.test(to.trim())) throw new Error("Enter the recipient's account number");
            if (mode === "chain" && !isAddress(to.trim())) throw new Error("Enter a valid 0x address");
        } catch (caught) {
            setError((caught as Error).message);
            return;
        }

        setBusy(true);
        try {
            if (mode === "user") {
                const moved = await api<{ balance: string }>("/transfers", {
                    body: { fromAccountId: accountId, toAccountId: to.trim(), amount: minor.toString() },
                    idempotencyKey: key,
                });
                setResult(`Sent ${usdc(minor)} to account ${to.trim()}. Your balance is now ${usdc(moved.balance)}.`);
            } else {
                const payout = await api<{ withdrawalId: string }>("/payouts", {
                    body: { accountId, to: to.trim(), amount: minor.toString() },
                    idempotencyKey: key,
                });
                setResult(`Payout ${payout.withdrawalId} accepted: ${usdc(minor)} is set aside and on its way.`);
            }
            nextKey();
            setAmount("");
        } catch (caught) {
            setError(
                caught instanceof ApiError && caught.code === "insufficient_funds"
                    ? "Not enough available balance."
                    : caught instanceof ApiError && caught.code === "account_not_found"
                      ? "No such account."
                      : (caught as Error).message,
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="page narrow">
            <form className="card reveal" onSubmit={submit} aria-label="Send">
                <div className="tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={mode === "user"} onClick={() => setMode("user")}>
                        To another user
                    </button>
                    <button type="button" role="tab" aria-selected={mode === "chain"} onClick={() => setMode("chain")}>
                        On chain
                    </button>
                </div>
                <p className="muted">
                    {mode === "user"
                        ? "Moves inside the ledger: free, instant, and nothing touches the chain."
                        : "Leaves custody: set aside now, paid out from the hot wallet in a block or two."}
                </p>
                <label>
                    {mode === "user" ? "Recipient's account number" : "Recipient address"}
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={mode === "user" ? "e.g. 7" : "0x…"} />
                </label>
                <label>
                    Amount
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </label>
                {error && <p className="error" role="alert">{error}</p>}
                {result && <p className="success" role="status">{result}</p>}
                <button className="primary" disabled={busy}>
                    {busy ? "Sending…" : mode === "user" ? "Send" : "Pay out"}
                </button>
            </form>
        </main>
    );
}
