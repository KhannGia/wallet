import { LedgerError } from "../ledger/errors.ts";

export class ReservesNotConfigured extends LedgerError {
    constructor() {
        super("reserves_not_configured", 503, "Proof of reserves needs USDC_ADDRESS to be set");
    }
}

export class NoReservesSnapshot extends LedgerError {
    constructor() {
        super("no_reserves_snapshot", 404, "No reserves snapshot has been taken yet");
    }
}
