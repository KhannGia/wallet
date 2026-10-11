-- Graduation: a user leaves custody for a smart account of their own.
--
-- The account is activated before any money moves. The user's own key signs
-- the operation that deploys it, so by the time funds are sent the platform has
-- seen, on chain, that the address holds a SmartAccount answering to that key.
-- Sending first to an address with nothing deployed would leave the funds
-- behind a key the user may already have lost, with no guardian able to help.
--
--   AWAITING_ACTIVATION  opened; nothing reserved, waiting for the deployment
--   FUNDING              deployed and checked; the whole balance is reserved
--                        and on its way through the withdrawal worker
--   COMPLETED            the transfer settled; the user's balance left custody
--   FAILED               the transfer failed and the balance came back
--   CANCELLED            abandoned before activation; nothing had moved
--
-- Funding is a payout like any other -- the same reservation in
-- PENDING_WITHDRAWALS, nonce allocation, replacement and refund -- marked with
-- its own kind so the two can be told apart.

ALTER TYPE withdrawal_kind ADD VALUE 'GRADUATION';

-- The checks written in 0010 named PAYOUT as the only kind with an account and
-- ledger transactions. A graduation has both; a rebalance is still the only
-- kind without them, so the checks are restated in terms of it.
ALTER TABLE chain_withdrawals
    DROP CONSTRAINT chain_withdrawals_payout_has_account,
    DROP CONSTRAINT chain_withdrawals_rebalance_has_no_ledger;

ALTER TABLE chain_withdrawals
    ADD CONSTRAINT chain_withdrawals_account_matches_kind CHECK (
        (kind = 'REBALANCE') = (account_id IS NULL)
    ),
    ADD CONSTRAINT chain_withdrawals_rebalance_has_no_ledger CHECK (
        kind <> 'REBALANCE'
        OR (reserved_transaction_id IS NULL AND settled_transaction_id IS NULL)
    );

CREATE TYPE graduation_status AS ENUM (
    'AWAITING_ACTIVATION', 'FUNDING', 'COMPLETED', 'FAILED', 'CANCELLED'
);

CREATE TABLE graduations (
    id             BIGSERIAL PRIMARY KEY,
    account_id     BIGINT NOT NULL REFERENCES accounts (id),

    -- The key the user holds, and the account the factory derives from it.
    -- Registered in smart_accounts, so the paymaster sponsors its deployment.
    owner          TEXT NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
    smart_account  TEXT NOT NULL REFERENCES smart_accounts (address),

    status         graduation_status NOT NULL DEFAULT 'AWAITING_ACTIVATION',

    -- Set together when funding starts: what was reserved, and the payout
    -- carrying it.
    amount         BIGINT CHECK (amount > 0),
    withdrawal_id  BIGINT UNIQUE REFERENCES chain_withdrawals (id),

    failure        TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    funded_at      TIMESTAMPTZ,
    settled_at     TIMESTAMPTZ,

    CONSTRAINT graduations_funding_has_withdrawal CHECK (
        (status IN ('AWAITING_ACTIVATION', 'CANCELLED')) = (withdrawal_id IS NULL)
    ),
    CONSTRAINT graduations_amount_with_withdrawal CHECK (
        (amount IS NULL) = (withdrawal_id IS NULL)
    )
);

-- One graduation in progress per account. Two at once could each reserve "the
-- whole balance", and the second would find nothing left -- or worse, a user
-- double-clicking would open two accounts for one balance.
CREATE UNIQUE INDEX graduations_one_open_per_account
    ON graduations (account_id)
    WHERE status IN ('AWAITING_ACTIVATION', 'FUNDING');
