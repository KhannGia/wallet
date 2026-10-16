/**
 * The API, as the browser sees it: same origin, through Vite's proxy.
 *
 * The session token lives in sessionStorage -- gone when the tab closes, and
 * never sent anywhere but in the Authorization header of our own requests.
 * Any script running on this page could still read it, which is why the page
 * loads no third-party code at all.
 */

const SESSION_KEY = "wallet.session";

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const session = {
    get: (): string | null => sessionStorage.getItem(SESSION_KEY),
    set: (token: string) => sessionStorage.setItem(SESSION_KEY, token),
    clear: () => sessionStorage.removeItem(SESSION_KEY),
};

/** Fired when the server stops accepting the session, so the app can return to sign-in. */
export const SIGNED_OUT = "wallet:signed-out";

export async function api<T>(
    path: string,
    options: { method?: string; body?: unknown; idempotencyKey?: string; token?: string } = {},
): Promise<T> {
    const headers: Record<string, string> = {};
    const token = options.token ?? session.get();
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const response = await fetch(`/api/v1${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 204) return undefined as T;

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 && body.error === "not_signed_in") {
            session.clear();
            window.dispatchEvent(new Event(SIGNED_OUT));
        }
        throw new ApiError(response.status, body.error ?? "error", body.message ?? response.statusText);
    }
    return body as T;
}

export interface Config {
    chainId: number;
    token: { address: `0x${string}` | null; symbol: string; decimals: number };
    entryPoint: `0x${string}`;
    accountFactory: `0x${string}` | null;
    paymaster: `0x${string}` | null;
    guardianModule: `0x${string}` | null;
    reservesRegistry: `0x${string}` | null;
    vault: `0x${string}` | null;
}

export interface Me {
    userId: string;
    email: string;
    accounts: { accountId: string; depositAddress: string | null }[];
}

export interface Account {
    id: string;
    balance: string;
    pendingBalance: string;
    reservedBalance: string;
    depositAddress: string | null;
}

export interface Entry {
    id: string;
    transactionId: string;
    kind: string;
    amount: string;
    balanceAfter: string;
    createdAt: string;
}

export type GraduationStatus = "AWAITING_ACTIVATION" | "FUNDING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface Graduation {
    id: string;
    accountId: string;
    owner: `0x${string}`;
    smartAccount: `0x${string}`;
    factory: `0x${string}`;
    salt: string;
    status: GraduationStatus;
    amount: string | null;
    withdrawalId: string | null;
    failure: string | null;
}

/** The smart account a user has graduated to, if any: the latest one money reached or is reaching. */
export function graduatedAccount(graduations: Graduation[] | undefined): Graduation | undefined {
    return graduations?.find((g) => g.status === "COMPLETED" || g.status === "FUNDING");
}
