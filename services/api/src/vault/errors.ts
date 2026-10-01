import { LedgerError } from "../ledger/errors.ts";

export class ProposalNotFound extends LedgerError {
    constructor(id: bigint) {
        super("proposal_not_found", 404, `Vault proposal ${id} does not exist`);
    }
}

export class ProposalNotOpen extends LedgerError {
    constructor(id: bigint, status: string) {
        super("proposal_not_open", 409, `Vault proposal ${id} is ${status}, not collecting`);
    }
}

export class ProposalAlreadyOpen extends LedgerError {
    constructor(nonce: bigint) {
        super(
            "proposal_already_open",
            409,
            `A proposal for vault nonce ${nonce} is already collecting signatures`,
        );
    }
}

export class DeadlineInPast extends LedgerError {
    constructor(deadline: bigint, now: bigint) {
        super("deadline_in_past", 422, `Deadline ${deadline} is not after chain time ${now}`);
    }
}

export class ProposalExpired extends LedgerError {
    constructor(id: bigint) {
        super("proposal_expired", 410, `Vault proposal ${id} passed its deadline`);
    }
}

export class ProposalStale extends LedgerError {
    constructor(id: bigint, proposed: bigint, current: bigint) {
        super(
            "proposal_stale",
            409,
            `Vault proposal ${id} was for nonce ${proposed}, but the vault is at ${current}; ` +
                "its signatures can never be used",
        );
    }
}

export class InvalidSignature extends LedgerError {
    constructor(reason: string) {
        super("invalid_signature", 422, reason);
    }
}

export class NotAVaultOwner extends LedgerError {
    constructor(signer: string) {
        super("not_a_vault_owner", 403, `${signer} is not an owner of this vault`);
    }
}

export class DuplicateSignature extends LedgerError {
    constructor(signer: string) {
        super("duplicate_signature", 409, `${signer} has already signed this proposal`);
    }
}

export class NotEnoughSignatures extends LedgerError {
    constructor(collected: number, threshold: number) {
        super(
            "not_enough_signatures",
            409,
            `${collected} of ${threshold} required signatures collected`,
        );
    }
}

export class VaultNotConfigured extends LedgerError {
    constructor() {
        super(
            "vault_not_configured",
            503,
            "No vault is configured, so proposals are unavailable. Set VAULT_ADDRESS.",
        );
    }
}
