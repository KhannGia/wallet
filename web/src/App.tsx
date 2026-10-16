import { useCallback, useEffect, useState } from "react";

import { api, graduatedAccount, session, SIGNED_OUT, type Config, type Graduation, type Me } from "./api.ts";
import { CustodyDial, type Tier } from "./components/CustodyDial.tsx";
import { Auth } from "./pages/Auth.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Graduate } from "./pages/Graduate.tsx";
import { Guard } from "./pages/Guard.tsx";
import { Guardians } from "./pages/Guardians.tsx";
import { Sessions } from "./pages/Sessions.tsx";
import { Vault } from "./pages/Vault.tsx";
import { Reserves } from "./pages/Reserves.tsx";
import { Send } from "./pages/Send.tsx";
import { SmartAccount } from "./pages/SmartAccount.tsx";
import { navigate, useRoute } from "./router.ts";

const NAV = [
    { route: "/", label: "Account" },
    { route: "/send", label: "Send" },
    { route: "/graduate", label: "Self-custody" },
    { route: "/smart", label: "Smart account" },
    { route: "/guardians", label: "Guardians" },
    { route: "/sessions", label: "Sessions" },
    { route: "/reserves", label: "Reserves" },
    { route: "/vault", label: "Vault" },
];

export function App() {
    const route = useRoute();
    const [config, setConfig] = useState<Config>();
    const [me, setMe] = useState<Me | null>();
    const [graduations, setGraduations] = useState<Graduation[]>();

    const loadMe = useCallback(async () => {
        if (!session.get()) return setMe(null);
        try {
            setMe(await api<Me>("/me"));
        } catch {
            setMe(null);
        }
    }, []);

    useEffect(() => {
        void api<Config>("/config").then(setConfig);
        void loadMe();
        const onSignedOut = () => setMe(null);
        window.addEventListener(SIGNED_OUT, onSignedOut);
        return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
    }, [loadMe]);

    const accountId = me?.accounts[0]?.accountId;
    const loadGraduations = useCallback(() => {
        if (accountId === undefined) return;
        void api<Graduation[]>(`/accounts/${accountId}/graduations`).then(setGraduations, () => setGraduations([]));
    }, [accountId]);
    useEffect(loadGraduations, [loadGraduations]);

    // A guardian approving a recovery need not be a user here at all.
    const guarding = /^\/guard\/(\d+)$/.exec(route);
    if (guarding) return <Guard id={guarding[1]!} />;

    if (config === undefined || me === undefined) return <div className="loading">Opening the ledger…</div>;
    if (me === null) {
        return (
            <Auth
                onSignedIn={() => {
                    navigate("/");
                    void loadMe();
                }}
            />
        );
    }

    if (accountId === undefined) return <div className="loading">This user has no account.</div>;
    // The needle moves when money has actually reached an account only the user controls.
    const tier: Tier = graduatedAccount(graduations) ? "smart" : "starter";

    async function signOut() {
        await api("/sessions/current", { method: "DELETE" }).catch(() => undefined);
        session.clear();
        setGraduations(undefined);
        setMe(null);
    }

    return (
        <div className="shell">
            <header className="masthead">
                <div className="brand">
                    <span className="mark" aria-hidden="true">§</span>
                    <div>
                        <strong>Ledger &amp; Key</strong>
                        <small>
                            account <b data-testid="account-id">{accountId}</b> · {me.email}
                        </small>
                    </div>
                </div>
                <CustodyDial tier={tier} />
                <nav aria-label="Main">
                    {NAV.map((item) => (
                        <a key={item.route} href={`#${item.route}`} aria-current={route === item.route ? "page" : undefined}>
                            {item.label}
                        </a>
                    ))}
                    <button type="button" className="link" onClick={() => void signOut()}>
                        Sign out
                    </button>
                </nav>
            </header>
            {route === "/send" ? (
                <Send accountId={accountId} />
            ) : route === "/graduate" ? (
                <Graduate accountId={accountId} config={config} onGraduated={loadGraduations} />
            ) : route === "/smart" ? (
                <SmartAccount accountId={accountId} config={config} graduations={graduations} />
            ) : route === "/guardians" ? (
                <Guardians accountId={accountId} config={config} graduations={graduations} />
            ) : route === "/sessions" ? (
                <Sessions accountId={accountId} config={config} graduations={graduations} />
            ) : route === "/vault" ? (
                <Vault config={config} />
            ) : route === "/reserves" ? (
                <Reserves accountId={accountId} config={config} />
            ) : (
                <Dashboard accountId={accountId} config={config} />
            )}
        </div>
    );
}
