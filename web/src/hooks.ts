import { useCallback, useEffect, useRef, useState } from "react";

/** Loads on mount and every `intervalMs`; the page reflects the chain moving underneath it. */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const loadRef = useRef(load);
    loadRef.current = load;

    const refresh = useCallback(async () => {
        try {
            setData(await loadRef.current());
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), intervalMs);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [intervalMs, refresh, ...deps]);

    return { data, error, refresh };
}

/**
 * 128 random bits, hex. Not crypto.randomUUID(): browsers offer that only in a
 * secure context (HTTPS or localhost), and the demo is also reached over plain
 * http by name. getRandomValues has no such restriction.
 */
export function randomKey(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One idempotency key per thing the user means to do, kept across retries of
 * that same submission and replaced once it succeeds -- so a double click or a
 * retry after a timeout cannot move the money twice.
 */
export function useIdempotencyKey(): [string, () => void] {
    const [key, setKey] = useState(randomKey);
    return [key, () => setKey(randomKey())];
}
