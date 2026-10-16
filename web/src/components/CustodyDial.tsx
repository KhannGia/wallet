/**
 * Custody as a dial, not a switch: where the platform holds the money, where
 * the user holds it through a smart account, and where they hold it outright.
 * The needle points at the tier this user is in.
 */
export type Tier = "starter" | "smart" | "sovereign";

const TIERS: { id: Tier; label: string; note: string }[] = [
    { id: "starter", label: "Starter", note: "the platform holds it" },
    { id: "smart", label: "Smart", note: "your key, our gas" },
    { id: "sovereign", label: "Sovereign", note: "yours alone" },
];

const ANGLE: Record<Tier, number> = { starter: -50, smart: 0, sovereign: 50 };

export function CustodyDial({ tier }: { tier: Tier }) {
    return (
        <figure className="dial" aria-label={`Custody tier: ${tier}`}>
            <svg viewBox="0 0 120 70" className="dial-face" aria-hidden="true">
                <path d="M10 64 A50 50 0 0 1 110 64" className="dial-arc" />
                {[-50, 0, 50].map((angle) => (
                    <line
                        key={angle}
                        x1="60"
                        y1="18"
                        x2="60"
                        y2="24"
                        className="dial-tick"
                        transform={`rotate(${angle} 60 64)`}
                    />
                ))}
                <g className="dial-needle" style={{ transform: `rotate(${ANGLE[tier]}deg)` }}>
                    <line x1="60" y1="64" x2="60" y2="22" />
                </g>
                <circle cx="60" cy="64" r="4.5" className="dial-hub" />
            </svg>
            <figcaption>
                {TIERS.map((t) => (
                    <span key={t.id} className={t.id === tier ? "tier current" : "tier"}>
                        <b>{t.label}</b>
                        <small>{t.note}</small>
                    </span>
                ))}
            </figcaption>
        </figure>
    );
}
