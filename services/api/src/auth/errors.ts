import { LedgerError } from "../ledger/errors.ts";

export class NotSignedIn extends LedgerError {
    constructor() {
        super("not_signed_in", 401, "Sign in first: send Authorization: Bearer <token>");
    }
}

/** The same answer for an unknown email and a wrong password, so neither reveals which accounts exist. */
export class InvalidCredentials extends LedgerError {
    constructor() {
        super("invalid_credentials", 401, "Email or password is wrong");
    }
}

export class EmailTaken extends LedgerError {
    constructor() {
        super("email_taken", 409, "An account with this email already exists");
    }
}

export class NotAdmin extends LedgerError {
    constructor() {
        super("not_admin", 401, "This endpoint needs the admin token");
    }
}

export class AdminNotConfigured extends LedgerError {
    constructor() {
        super("admin_not_configured", 503, "Set API_ADMIN_TOKEN to use the admin endpoints");
    }
}
