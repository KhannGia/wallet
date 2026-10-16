import { useState, type FormEvent } from "react";
import { encodeFunctionData, erc20Abi, isAddress, parseAbi, type Address } from "viem";

import { sendSponsored, smartAccount } from "../aa.ts";
import { graduatedAccount, type Config, type Graduation } from "../api.ts";
import { publicClient } from "../chain.ts";
import { errorMessage, parseUsdc, usdc } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { loadOwner } from "../keys.ts";

const accountAbi = parseAbi([
    "function owner() view returns (address)",
    "function recoveryModule() view returns (address)",
]);
const moduleAbi = parseAbi(["function threshold(address account) view returns (uint256)"]);

/**
 * The account the user graduated to, read straight from the chain -- not from
 * our database, which has no say over it any more.
 */
export function SmartAccount({ accountId, config, graduations }: { accountId: string; config: Config; graduations: Graduation[] | undefined }) {
    const graduated = graduatedAccount(graduations);
    const address = graduated?.smartAccount as Address | undefined;
    const owner = loadOwner(accountId);
    const [to, setTo] = useState("");
    const [amount, setAmount] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string>();
    const [error, setError] = useState<string>();

    const state = usePolling(
        async () => {
            if (!address || !config.token.address) return undefined;
            const [balance, ether, chainOwner, module] = await Promise.all([
                publicClient.readContract({ address: config.token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
                publicClient.getBalance({ address }),
                publicClient.readContract({ address, abi: accountAbi, functionName: "owner" }),
                publicClient.readContract({ address, abi: accountAbi, functionName: "recoveryModule" }),
            ]);
            const threshold =
                module === "0x0000000000000000000000000000000000000000"
                    ? 0n
                    : await publicClient.readContract({ address: module, abi: moduleAbi, functionName: "threshold", args: [address] });
            return { balance, ether, chainOwner, module, threshold };
        },
        3_000,
        [address],
    );

    if (!address) {
        return (
            <main className="page narrow">
                <section className="card reveal">
                    <h2>No smart account yet</h2>
                    <p>
                        Graduate first: <a href="#/graduate">move your balance to an account only you control</a>.
                    </p>
                </section>
            </main>
        );
    }

    const s = state.data;
    const ownsHere = owner && s && owner.address.toLowerCase() === s.chainOwner.toLowerCase();

    async function send(event: FormEvent) {
        event.preventDefault();
        setError(undefined);
        setResult(undefined);
        try {
            const minor = parseUsdc(amount);
            if (!isAddress(to.trim())) throw new Error("Enter a valid 0x address");
            setBusy(true);
            const account = await smartAccount(owner!, config.accountFactory!, address);
            const tx = await sendSponsored(account, [
                {
                    to: config.token.address!,
                    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to.trim() as Address, minor] }),
                },
            ]);
            setResult(`Sent ${usdc(minor)} ${config.token.symbol}. Transaction ${tx.slice(0, 10)}…, gas paid by the platform.`);
            setAmount("");
            await state.refresh();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="page">
            <section className="balances reveal" aria-label="Smart account">
                <div className="figure hero">
                    <span className="label">In your smart account</span>
                    <span className="amount" data-testid="smart-balance">
                        {s ? usdc(s.balance) : "—"}
                    </span>
                    <span className="unit">{config.token.symbol}, on chain</span>
                </div>
                <div className="figure">
                    <span className="label">Ether held</span>
                    <span className="amount small">{s ? s.ether.toString() : "—"}</span>
                    <span className="note">none needed: the paymaster pays gas</span>
                </div>
                <div className="figure">
                    <span className="label">Guardians to recover</span>
                    <span className="amount small" data-testid="threshold">
                        {s ? (s.threshold === 0n ? "none" : s.threshold.toString()) : "—"}
                    </span>
                    <span className="note">{s && s.threshold > 0n ? "must agree, then 48 hours" : "add some on the Guardians page"}</span>
                </div>
            </section>

            <section className="card facts reveal" aria-label="Account facts">
                <h2>On chain</h2>
                <dl>
                    <dt>Address</dt>
                    <dd>
                        <code data-testid="smart-address">{address}</code>
                    </dd>
                    <dt>Owner</dt>
                    <dd>
                        <code>{s?.chainOwner ?? "…"}</code> {ownsHere ? <em>— the key in this browser</em> : owner ? <em className="error">— not this browser's key</em> : null}
                    </dd>
                    <dt>Recovery module</dt>
                    <dd>
                        <code>{s?.module ?? "…"}</code>
                    </dd>
                </dl>
                <p className="muted">
                    Nothing on this page comes from our database: every figure is read from the chain. The platform holds
                    no key that can move these funds.
                </p>
            </section>

            <form className="card reveal" onSubmit={send} aria-label="Send from smart account">
                <h2>Send</h2>
                {!ownsHere && <p className="error">This browser does not hold the owner key, so it cannot sign for this account.</p>}
                <label>
                    Recipient address
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" />
                </label>
                <label>
                    Amount
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </label>
                {error && <p className="error" role="alert">{error}</p>}
                {result && <p className="success" role="status">{result}</p>}
                <button className="primary" disabled={busy || !ownsHere}>
                    {busy ? "Signing and sending…" : "Sign and send"}
                </button>
            </form>
        </main>
    );
}
