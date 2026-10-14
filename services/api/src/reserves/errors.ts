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

export class ReservesSnapshotNotFound extends LedgerError {
    constructor(id: bigint) {
        super("reserves_snapshot_not_found", 404, `Reserves snapshot ${id} does not exist`);
    }
}

export class NoTreeForSnapshot extends LedgerError {
    constructor(id: bigint) {
        super("no_tree_for_snapshot", 404, `Reserves snapshot ${id} was taken before snapshots had a Merkle tree`);
    }
}

export class NotInSnapshot extends LedgerError {
    constructor(id: bigint, accountId: bigint) {
        super("not_in_snapshot", 404, `Account ${accountId} has no leaf in reserves snapshot ${id}`);
    }
}
