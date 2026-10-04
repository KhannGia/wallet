-- Hot/cold rebalancing.
--
-- Moving reserves between the hot wallet and the vault changes where the
-- platform's tokens sit, not what any user is owed, so neither direction
-- touches the ledger.
--
-- Hot -> vault is a transfer signed with the hot wallet's key, and only the
-- withdrawal worker may sign with it: it allocates that account's nonces, and
-- a second sender would collide with them. So the transfer is a row in
-- chain_withdrawals, carried by the same machinery as a payout -- nonce
-- allocation, stuck replacement, abandonment -- but with no account and no
-- ledger transactions.

CREATE TYPE withdrawal_kind AS ENUM ('PAYOUT', 'REBALANCE');

ALTER TABLE chain_withdrawals
    ADD COLUMN kind withdrawal_kind NOT NULL DEFAULT 'PAYOUT',
    ALTER COLUMN account_id DROP NOT NULL,
    DROP CONSTRAINT chain_withdrawals_settled_has_transaction;

ALTER TABLE chain_withdrawals
    -- A payout always belongs to a user; a rebalance never does.
    ADD CONSTRAINT chain_withdrawals_payout_has_account CHECK (
        (kind = 'PAYOUT') = (account_id IS NOT NULL)
    ),
    -- A settled payout always produced a ledger transaction...
    ADD CONSTRAINT chain_withdrawals_settled_has_transaction CHECK (
        kind = 'REBALANCE'
        OR (status IN ('CONFIRMED', 'FAILED')) = (settled_transaction_id IS NOT NULL)
    ),
    -- ...and a rebalance never produces one.
    ADD CONSTRAINT chain_withdrawals_rebalance_has_no_ledger CHECK (
        kind = 'PAYOUT'
        OR (reserved_transaction_id IS NULL AND settled_transaction_id IS NULL)
    );

-- One rebalance in flight at a time. A second, planned from a balance that
-- does not yet reflect the first, would move the excess twice.
CREATE UNIQUE INDEX chain_withdrawals_one_rebalance_in_flight
    ON chain_withdrawals (kind)
    WHERE kind = 'REBALANCE' AND status IN ('PENDING', 'SUBMITTED');

-- Vault -> hot is a vault proposal like any other, opened automatically when
-- the hot wallet runs low. Marking it lets the rebalancer see a top-up is
-- already waiting for owners rather than opening another.
CREATE TYPE vault_proposal_kind AS ENUM ('MANUAL', 'REBALANCE');

ALTER TABLE vault_proposals
    ADD COLUMN kind vault_proposal_kind NOT NULL DEFAULT 'MANUAL';
