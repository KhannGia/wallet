-- Deposits observed on-chain, and the two-step path they take into the ledger.
--
-- A transfer seen in a block that is not yet final must not increase what a
-- user can spend: the block can still be replaced. So the money is parked in a
-- system account first and only released once the block is final. The user's
-- balance therefore always means "spendable", and a reversal never has to claw
-- funds back from someone who has already spent them.
--
--   seen        BANK_GATEWAY     -> PENDING_DEPOSITS   (status PENDING)
--   final       PENDING_DEPOSITS -> user account       (status CONFIRMED)
--   reorged     PENDING_DEPOSITS -> BANK_GATEWAY       (status REORGED, P4)

CREATE TYPE deposit_status AS ENUM ('PENDING', 'CONFIRMED', 'REORGED');

INSERT INTO accounts (type, system_key) VALUES ('SYSTEM', 'PENDING_DEPOSITS');

CREATE TABLE chain_deposits (
    id               BIGSERIAL PRIMARY KEY,

    -- A log's position on the canonical chain. Unique by definition, which is
    -- why no idempotency key has to be invented for a deposit: the chain
    -- already provides one.
    transaction_hash TEXT NOT NULL,
    log_index        INTEGER NOT NULL CHECK (log_index >= 0),

    -- Kept so P4 can ask whether the block this arrived in is still canonical.
    block_number     BIGINT NOT NULL CHECK (block_number >= 0),
    block_hash       TEXT NOT NULL,

    token_address    TEXT NOT NULL,
    from_address     TEXT NOT NULL,
    to_address       TEXT NOT NULL,
    amount           BIGINT NOT NULL CHECK (amount > 0),

    account_id       BIGINT NOT NULL REFERENCES accounts (id),
    status           deposit_status NOT NULL DEFAULT 'PENDING',

    -- The two ledger transactions this deposit produces over its lifetime.
    credited_transaction_id  BIGINT REFERENCES transactions (id),
    confirmed_transaction_id BIGINT REFERENCES transactions (id),

    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at     TIMESTAMPTZ,

    -- Seeing the same log twice is normal: block ranges overlap on restart.
    -- The constraint is what makes reprocessing harmless.
    CONSTRAINT chain_deposits_log_identity UNIQUE (transaction_hash, log_index),

    CONSTRAINT chain_deposits_confirmed_has_transaction CHECK (
        (status = 'CONFIRMED') = (confirmed_transaction_id IS NOT NULL)
    )
);

-- P4 rolls back by block height, so that lookup gets an index.
CREATE INDEX chain_deposits_block_idx ON chain_deposits (block_number);

-- Partial index: only pending rows are ever scanned for promotion, and they
-- are a small minority once the wallet has been running for a while.
CREATE INDEX chain_deposits_pending_idx ON chain_deposits (block_number)
    WHERE status = 'PENDING';

CREATE INDEX chain_deposits_account_idx ON chain_deposits (account_id, status);

-- Log addresses arrive from the node in whatever case the client produced, so
-- the lookup that maps a transfer to an account is case-insensitive and needs
-- a matching functional index.
CREATE INDEX accounts_deposit_address_lower_idx ON accounts (lower(deposit_address));
