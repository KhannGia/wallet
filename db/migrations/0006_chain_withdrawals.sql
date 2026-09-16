-- Outgoing transfers, and the state machine they move through.
--
-- The mirror image of a deposit. Funds leave the user's account the moment a
-- withdrawal is requested and wait in PENDING_WITHDRAWALS until the chain
-- accepts them, so the same balance cannot be spent twice while a transaction
-- is in flight. If the transaction fails, the money comes back from that system
-- account rather than being conjured.
--
--   requested   user             -> PENDING_WITHDRAWALS   (status PENDING)
--   submitted   no ledger movement; the money is in flight
--   confirmed   PENDING_WITHDRAWALS -> BANK_GATEWAY       (status CONFIRMED)
--   failed      PENDING_WITHDRAWALS -> user               (status FAILED)

CREATE TYPE withdrawal_status AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

INSERT INTO accounts (type, system_key) VALUES ('SYSTEM', 'PENDING_WITHDRAWALS');

CREATE TABLE chain_withdrawals (
    id            BIGSERIAL PRIMARY KEY,
    account_id    BIGINT NOT NULL REFERENCES accounts (id),
    to_address    TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-fA-F]{40}$'),
    token_address TEXT NOT NULL,
    amount        BIGINT NOT NULL CHECK (amount > 0),

    hot_wallet_id TEXT REFERENCES hot_wallets (id),

    -- Assigned once and then reused for every resend. A replacement must carry
    -- the same nonce as the transaction it replaces, and allocating a fresh one
    -- after a failed broadcast would leave a hole that stalls the queue.
    nonce         BIGINT CHECK (nonce >= 0),

    -- Not unique: a replacement is a different transaction with the same nonce,
    -- and either one may be the one that gets mined.
    transaction_hash TEXT,

    -- The fees the latest attempt used, so a replacement can be priced above
    -- them. Nodes reject a replacement that does not raise the fee enough.
    max_fee_per_gas          BIGINT,
    max_priority_fee_per_gas BIGINT,
    attempts                 INTEGER NOT NULL DEFAULT 0,

    status        withdrawal_status NOT NULL DEFAULT 'PENDING',
    failure       TEXT,

    -- The ledger transactions this withdrawal produces over its lifetime.
    reserved_transaction_id BIGINT REFERENCES transactions (id),
    settled_transaction_id  BIGINT REFERENCES transactions (id),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at  TIMESTAMPTZ,
    settled_at    TIMESTAMPTZ,

    CONSTRAINT chain_withdrawals_submitted_has_nonce CHECK (
        status = 'PENDING' OR (nonce IS NOT NULL AND hot_wallet_id IS NOT NULL)
    ),
    CONSTRAINT chain_withdrawals_settled_has_transaction CHECK (
        (status IN ('CONFIRMED', 'FAILED')) = (settled_transaction_id IS NOT NULL)
    )
);

CREATE INDEX chain_withdrawals_status_idx ON chain_withdrawals (status, id);
CREATE INDEX chain_withdrawals_account_idx ON chain_withdrawals (account_id);

-- One in-flight nonce per wallet per withdrawal: two rows sharing a nonce would
-- mean two different withdrawals competing for the same slot.
CREATE UNIQUE INDEX chain_withdrawals_nonce_key
    ON chain_withdrawals (hot_wallet_id, nonce)
    WHERE nonce IS NOT NULL;
