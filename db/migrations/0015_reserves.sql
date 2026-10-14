-- Proof of reserves: snapshots of what the platform holds on chain against
-- what it owes its users.
--
-- Both sides are read at one block. The ledger is read in a single snapshot
-- together with the indexer's cursor, and the cursor is the block: every
-- deposit the ledger knows about arrived at or before it, so the chain
-- balances read at that block include every token the ledger counts as owed.
--
-- A surplus is normal -- a deposit not yet indexed, a payout settled in the
-- ledger a block after the snapshot's block. A shortfall is an incident.

CREATE TABLE reserve_snapshots (
    id             BIGSERIAL PRIMARY KEY,
    token_address  TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
    block_number   BIGINT NOT NULL CHECK (block_number >= 0),

    -- Token balances of every address the platform controls, at block_number.
    assets         NUMERIC(78, 0) NOT NULL CHECK (assets >= 0),
    -- What every user is owed: their balance, their deposits not yet final,
    -- and their payouts not yet on chain.
    liabilities    NUMERIC(78, 0) NOT NULL CHECK (liabilities >= 0),

    -- The breakdown behind both totals, for whoever has to explain a shortfall.
    detail         JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reserve_snapshots_latest_idx ON reserve_snapshots (id DESC);

-- One row per user account per snapshot: what that user was owed. Summing them
-- gives the snapshot's liabilities, and each becomes a leaf of the Merkle tree
-- a user checks their own balance against.
CREATE TABLE reserve_liabilities (
    snapshot_id  BIGINT NOT NULL REFERENCES reserve_snapshots (id),
    account_id   BIGINT NOT NULL REFERENCES accounts (id),
    amount       NUMERIC(78, 0) NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (snapshot_id, account_id)
);
