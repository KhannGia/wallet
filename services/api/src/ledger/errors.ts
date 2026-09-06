/**
 * Errors the ledger raises deliberately, each carrying the HTTP status the API
 * should answer with. Anything else escaping the ledger is a bug, not a
 * business outcome, and must surface as a 500 rather than be dressed up as one
 * of these.
 */
export class LedgerError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, status: number, message: string) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.status = status;
    }
}

export class UnbalancedPostings extends LedgerError {
    constructor(total: bigint) {
        super(
            "unbalanced_postings",
            500,
            `Postings must sum to zero, got ${total}. Money cannot be created or destroyed.`,
        );
    }
}

export class InsufficientFunds extends LedgerError {
    constructor(accountId: bigint, balance: bigint, requested: bigint) {
        super(
            "insufficient_funds",
            422,
            `Account ${accountId} holds ${balance} but ${requested} was requested`,
        );
    }
}

export class AccountNotFound extends LedgerError {
    constructor(accountId: bigint) {
        super("account_not_found", 404, `Account ${accountId} does not exist`);
    }
}

export class IdempotencyKeyReused extends LedgerError {
    constructor() {
        super(
            "idempotency_key_reused",
            422,
            "This Idempotency-Key was already used for a different request body",
        );
    }
}

export class RequestInFlight extends LedgerError {
    constructor() {
        super("request_in_flight", 409, "A request with this Idempotency-Key is still running");
    }
}

export class MissingIdempotencyKey extends LedgerError {
    constructor() {
        super(
            "idempotency_key_required",
            400,
            "An Idempotency-Key header is required for requests that move money",
        );
    }
}
