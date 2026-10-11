import { LedgerError } from "../ledger/errors.ts";

export class GraduationNotConfigured extends LedgerError {
    constructor() {
        super(
            "graduation_not_configured",
            503,
            "Graduation needs ACCOUNT_FACTORY_ADDRESS and USDC_ADDRESS to be set",
        );
    }
}

export class GraduationNotFound extends LedgerError {
    constructor(id: bigint) {
        super("graduation_not_found", 404, `Graduation ${id} does not exist`);
    }
}

export class GraduationInProgress extends LedgerError {
    constructor(accountId: bigint, existing: bigint) {
        super(
            "graduation_in_progress",
            409,
            `Account ${accountId} already has graduation ${existing} in progress, for another key`,
        );
    }
}

export class GraduationNotOpen extends LedgerError {
    constructor(id: bigint, status: string) {
        super("graduation_not_open", 409, `Graduation ${id} is ${status}, not AWAITING_ACTIVATION`);
    }
}

export class NotActivated extends LedgerError {
    constructor(account: string, reason: string) {
        super("not_activated", 409, `Smart account ${account} is not ready: ${reason}`);
    }
}

export class NothingToGraduate extends LedgerError {
    constructor(accountId: bigint) {
        super("nothing_to_graduate", 422, `Account ${accountId} has no available balance to move`);
    }
}
