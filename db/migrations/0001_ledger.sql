-- The double-entry ledger.
--
-- Two rules govern everything here:
--   1. Money never changes; it only moves. Every transaction writes at least
--      two entries whose amounts sum to zero.
--   2. ledger_entries is append-only. A mistake is corrected with a reversing
--      entry, never by editing history.

CREATE TYPE account_type AS ENUM ('USER', 'SYSTEM');
CREATE TYPE tx_kind AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'REVERSAL');
CREATE TYPE tx_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

CREATE TABLE users (
    id         BIGSERIAL PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT REFERENCES users (id),
    type       account_type NOT NULL,
    -- Stable handle for system accounts, e.g. 'BANK_GATEWAY'. User accounts
    -- are addressed by user_id instead.
    system_key TEXT UNIQUE,
    currency   CHAR(3) NOT NULL DEFAULT 'USD',

    -- Denormalised cache of SUM(ledger_entries.amount) for this account.
    -- ledger_entries remains the source of truth; the reconciliation endpoint
    -- exists to prove the two never drift apart.
    balance    BIGINT NOT NULL DEFAULT 0,
    version    BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Last line of defence. The application checks the balance under a row
    -- lock; this catches any path that forgets to.
    CONSTRAINT accounts_user_balance_non_negative
        CHECK (type = 'SYSTEM' OR balance >= 0),

    -- A system account holds the counterparty side of deposits and
    -- withdrawals and is expected to run negative, so it carries no user.
    CONSTRAINT accounts_identity_matches_type CHECK (
        (type = 'USER' AND user_id IS NOT NULL AND system_key IS NULL)
        OR (type = 'SYSTEM' AND user_id IS NULL AND system_key IS NOT NULL)
    )
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE transactions (
    id              BIGSERIAL PRIMARY KEY,

    -- The UNIQUE constraint is what actually makes retries safe. An
    -- application-level "does this key exist yet" check is itself racy.
    idempotency_key TEXT NOT NULL UNIQUE,

    -- Hash of the request body. Catches a client reusing one key for two
    -- different requests, which uniqueness alone cannot detect.
    request_fingerprint TEXT NOT NULL,

    kind         tx_kind NOT NULL,
    status       tx_status NOT NULL DEFAULT 'PENDING',
    response     JSONB,
    metadata     JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE ledger_entries (
    id             BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES transactions (id),
    account_id     BIGINT NOT NULL REFERENCES accounts (id),

    -- Negative debits the account, positive credits it. Zero would be a
    -- meaningless entry, so it is rejected outright.
    amount         BIGINT NOT NULL CHECK (amount <> 0),

    -- Balance snapshot after this entry. Redundant, but it turns "why is this
    -- balance wrong" from an archaeology exercise into reading one column.
    balance_after  BIGINT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

CREATE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger_entries is append-only: correct mistakes with a reversing entry';
END;
$$ LANGUAGE plpgsql;

-- Append-only enforced by the database rather than by developer discipline.
CREATE TRIGGER ledger_entries_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Deposits credit a user from BANK_GATEWAY, which therefore holds a large
-- negative balance representing money held at the partner bank. That is
-- correct double-entry bookkeeping, not a bug.
INSERT INTO accounts (type, system_key)
VALUES ('SYSTEM', 'BANK_GATEWAY'),
       ('SYSTEM', 'FEE_REVENUE');
