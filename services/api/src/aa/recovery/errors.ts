import { LedgerError } from "../../ledger/errors.ts";

export class RecoveryNotFound extends LedgerError {
    constructor(id: bigint) {
        super("recovery_not_found", 404, `Recovery request ${id} does not exist`);
    }
}

export class RecoveryNotOpen extends LedgerError {
    constructor(id: bigint, status: string, wanted: string) {
        super("recovery_not_open", 409, `Recovery request ${id} is ${status}, not ${wanted}`);
    }
}

export class NotRecoverable extends LedgerError {
    constructor(account: string, reason: string) {
        super("not_recoverable", 409, `${account} cannot be recovered: ${reason}`);
    }
}

export class RecoveryDeadlineInPast extends LedgerError {
    constructor(deadline: bigint, now: bigint) {
        super("deadline_in_past", 422, `Deadline ${deadline} is not after chain time ${now}`);
    }
}

export class RecoveryExpired extends LedgerError {
    constructor(id: bigint) {
        super("recovery_expired", 410, `Recovery request ${id} passed its deadline`);
    }
}

export class InvalidGuardianSignature extends LedgerError {
    constructor(reason: string) {
        super("invalid_signature", 422, reason);
    }
}

export class NotAGuardian extends LedgerError {
    constructor(signer: string) {
        super("not_a_guardian", 403, `${signer} is not a guardian of this account`);
    }
}

export class DuplicateGuardianSignature extends LedgerError {
    constructor(signer: string) {
        super("duplicate_signature", 409, `${signer} has already signed this`);
    }
}

export class RecoveryNotConfigured extends LedgerError {
    constructor() {
        super(
            "recovery_not_configured",
            503,
            "No guardian module is configured, so recovery is unavailable. Set GUARDIAN_MODULE_ADDRESS.",
        );
    }
}
