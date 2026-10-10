-- Session keys the session manager holds on an app's behalf.
--
-- The private key is stored only encrypted (AES-256-GCM, see sessions/crypto.ts)
-- under a master key that never touches the database. Revoking or expiring a
-- session deletes the ciphertext outright: once gone, not even the service can
-- sign with that key again, whatever happens on chain.
--
--   PENDING  created; waiting for the owner to grant it on chain
--   ACTIVE   the account holds it as a live session
--   REVOKED  revoked here or on chain; the ciphertext is gone
--   EXPIRED  past valid_until; the ciphertext is gone

CREATE TYPE session_key_status AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED');

CREATE TABLE session_keys (
    id               BIGSERIAL PRIMARY KEY,
    account_address  TEXT NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
    key_address      TEXT NOT NULL UNIQUE CHECK (key_address ~ '^0x[0-9a-f]{40}$'),

    -- Null once shredded.
    ciphertext       BYTEA,
    iv               BYTEA,
    auth_tag         BYTEA,
    -- Which master key sealed it, so the master key can be rotated.
    key_version      INTEGER NOT NULL,

    -- What was asked for, kept for the record: the account holds the real rules.
    permissions      JSONB NOT NULL,
    valid_after      BIGINT NOT NULL,
    valid_until      BIGINT NOT NULL,

    status           session_key_status NOT NULL DEFAULT 'PENDING',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at         TIMESTAMPTZ,

    CONSTRAINT session_keys_live_has_key CHECK (
        (status IN ('PENDING', 'ACTIVE')) = (ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)
    )
);

CREATE INDEX session_keys_account_idx ON session_keys (account_address);
