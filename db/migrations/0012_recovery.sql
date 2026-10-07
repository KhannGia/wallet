-- Social recovery requests and the guardian signatures collected for them.
--
-- The same shape as vault proposals: approvals are gathered off-chain at the
-- guardians' pace, and only a quorum is ever submitted. A request moves through
--
--   COLLECTING  waiting for a quorum of guardian approvals
--   STARTED     initiateRecovery ran; the delay is running until executable_at
--   EXECUTED    the account now answers to new_owner
--   CANCELLED   the owner vetoed it, or a guardian quorum withdrew it
--   STALE       another recovery or a change of guardians spent the nonce first
--   EXPIRED     its deadline passed while collecting
--   LAPSED      it matured and nobody executed it within the module's window

CREATE TYPE recovery_status AS ENUM (
    'COLLECTING', 'STARTED', 'EXECUTED', 'CANCELLED', 'STALE', 'EXPIRED', 'LAPSED'
);

CREATE TABLE recovery_requests (
    id               BIGSERIAL PRIMARY KEY,
    module_address   TEXT NOT NULL CHECK (module_address ~ '^0x[0-9a-fA-F]{40}$'),
    chain_id         BIGINT NOT NULL,
    account_address  TEXT NOT NULL CHECK (account_address ~ '^0x[0-9a-fA-F]{40}$'),
    new_owner        TEXT NOT NULL CHECK (new_owner ~ '^0x[0-9a-fA-F]{40}$'),

    -- The module's nonce for this account when the approvals were requested.
    nonce            NUMERIC(78, 0) NOT NULL,
    deadline         BIGINT NOT NULL,
    digest           TEXT NOT NULL UNIQUE CHECK (digest ~ '^0x[0-9a-f]{64}$'),
    threshold        INTEGER NOT NULL CHECK (threshold > 0),

    status           recovery_status NOT NULL DEFAULT 'COLLECTING',
    executable_at    BIGINT,
    start_tx         TEXT,
    execute_tx       TEXT,

    -- A guardian quorum withdrawing the recovery signs over the nonce the
    -- module holds once it started, with its own deadline.
    cancel_deadline  BIGINT,
    cancel_digest    TEXT UNIQUE CHECK (cancel_digest ~ '^0x[0-9a-f]{64}$'),

    failure          TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at       TIMESTAMPTZ
);
-- Deliberately no "one open request per account". Anyone may open a request,
-- and such a rule would let a stranger block an owner's real recovery with a
-- bogus one until its deadline passed. Several may collect at once; whichever
-- starts first spends the nonce, and the rest become STALE.

CREATE INDEX recovery_requests_open_idx ON recovery_requests (status, id);

CREATE TYPE recovery_signature_kind AS ENUM ('APPROVE', 'CANCEL');

CREATE TABLE recovery_signatures (
    request_id  BIGINT NOT NULL REFERENCES recovery_requests (id),
    kind        recovery_signature_kind NOT NULL,
    -- Lower-case, so the key catches one guardian signing twice however the
    -- address was written.
    guardian    TEXT NOT NULL CHECK (guardian ~ '^0x[0-9a-f]{40}$'),
    signature   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, kind, guardian)
);
