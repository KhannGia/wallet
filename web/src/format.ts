import { fromMinorUnits, toMinorUnits, USDC_DECIMALS } from "@wallet/shared";

/** 1234500000 -> "1,234.5". Minor units in, never a float. */
export function usdc(minor: string | bigint): string {
    const text = fromMinorUnits(BigInt(minor), USDC_DECIMALS);
    const [whole = "0", fraction] = text.replace("-", "").split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const sign = text.startsWith("-") ? "−" : "";
    return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** "12.5" -> 12500000n, or an error a form can show. */
export function parseUsdc(input: string): bigint {
    const trimmed = input.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter an amount like 12.50");
    const minor = toMinorUnits(trimmed, USDC_DECIMALS);
    if (minor <= 0n) throw new Error("The amount must be more than zero");
    return minor;
}

export function shortAddress(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * What went wrong, in the words of whoever refused. viem wraps an RPC error
 * from the bundler or the paymaster in a generic message ("Invalid parameters
 * were provided to the RPC method") and keeps the service's own reason --
 * "sponsorship refused: ...", "AA24 signature error" -- in `details`.
 */
export function errorMessage(caught: unknown): string {
    if (caught && typeof caught === "object") {
        const error = caught as { details?: unknown; shortMessage?: unknown; message?: unknown };
        if (typeof error.details === "string" && error.details) return error.details;
        if (typeof error.shortMessage === "string" && error.shortMessage) return error.shortMessage;
        if (typeof error.message === "string") return error.message.split("\n")[0]!;
    }
    return String(caught);
}
