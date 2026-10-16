import { useState, type FormEvent } from "react";

import { api, ApiError, session } from "../api.ts";

/** Sign in, or open an account -- which signs in at once. */
export function Auth({ onSignedIn }: { onSignedIn: () => void }) {
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
            const result = await api<{ token: string }>(mode === "signup" ? "/users" : "/sessions", {
                body: { email, password },
            });
            session.set(result.token);
            onSignedIn();
        } catch (caught) {
            setError(
                caught instanceof ApiError && caught.code === "invalid_request"
                    ? "Use a valid email and a password of at least 12 characters."
                    : caught instanceof Error
                      ? caught.message
                      : String(caught),
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="auth">
            <section className="auth-pitch reveal">
                <p className="kicker">Ledger &amp; Key</p>
                <h1>
                    Start with us holding it.
                    <br />
                    <em>Leave with your own key.</em>
                </h1>
                <p className="lede">
                    A custodial wallet with the door left open: free, instant transfers while we hold your
                    balance, and one step to a smart account only you control — guardians if you lose the key,
                    no gas to think about.
                </p>
            </section>

            <form className="card auth-form reveal" onSubmit={submit} aria-label={mode === "signup" ? "Open an account" : "Sign in"}>
                <div className="tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
                        Sign in
                    </button>
                    <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
                        Open an account
                    </button>
                </div>
                <label>
                    Email
                    <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <label>
                    Password
                    <input
                        type="password"
                        autoComplete={mode === "signup" ? "new-password" : "current-password"}
                        required
                        minLength={mode === "signup" ? 12 : undefined}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    {mode === "signup" && <small>At least 12 characters. A sentence works well.</small>}
                </label>
                {error && <p className="error" role="alert">{error}</p>}
                <button className="primary" disabled={busy}>
                    {busy ? "One moment…" : mode === "signup" ? "Open my account" : "Sign in"}
                </button>
            </form>
        </main>
    );
}
