-- The vault holds most calls behind a timelock: an approval is queued, waits
-- out the vault's delay, and only then executes. Any single owner may cancel
-- it while it waits.
--
-- QUEUED     the vault accepted the approval and spent its nonce; the call
--            becomes executable at `eta` (chain time, unix seconds)
-- CANCELLED  an owner cancelled it on chain before it executed
--
-- A queued call that nobody executes within the vault's grace period ends as
-- EXPIRED, the same state an approval that never reached the chain ends in.

ALTER TYPE vault_proposal_status ADD VALUE 'QUEUED';
ALTER TYPE vault_proposal_status ADD VALUE 'CANCELLED';

ALTER TABLE vault_proposals
    ADD COLUMN eta BIGINT,
    ADD COLUMN queue_transaction_hash TEXT;
