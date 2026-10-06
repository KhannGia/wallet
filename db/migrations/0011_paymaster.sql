-- Gas sponsorship.
--
-- The paymaster pays for an operation once the sponsorship service has signed
-- for it, and that signature spends the platform's own ether. So only accounts
-- the platform knows are sponsored, and every signature is recorded, so a daily
-- cap can be held against what has been promised.

CREATE TABLE smart_accounts (
    -- Lower-case, so the same account written two ways is one row.
    address     TEXT PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
    owner       TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE paymaster_sponsorships (
    id            BIGSERIAL PRIMARY KEY,
    sender        TEXT NOT NULL REFERENCES smart_accounts (address),

    -- The full ERC-4337 nonce, key and sequence: up to 256 bits.
    user_op_nonce NUMERIC(78, 0) NOT NULL,

    -- The most the paymaster can be charged for the operation, in wei: every
    -- gas limit times the max fee. Counted against the cap whether or not the
    -- operation is ever sent, because once signed, it can be.
    max_cost      NUMERIC(78, 0) NOT NULL CHECK (max_cost >= 0),

    valid_until   BIGINT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One nonce can only ever execute once, so asking again for the same one
    -- -- a wallet retrying, or re-estimating -- replaces the earlier promise
    -- instead of being counted twice.
    UNIQUE (sender, user_op_nonce)
);

CREATE INDEX paymaster_sponsorships_window_idx ON paymaster_sponsorships (sender, created_at);
