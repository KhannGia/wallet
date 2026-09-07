-- Each user account gets its own on-chain deposit address, derived from the
-- extended public key at m/44'/60'/0'/0. The server holds only that xpub, so
-- it can generate addresses but cannot spend what arrives at them.

-- Indices are allocated from a sequence rather than MAX(index) + 1: nextval is
-- safe under concurrency without taking a lock, so two simultaneous signups
-- can never be handed the same address. Gaps left by a rolled-back transaction
-- are harmless -- an unused address is simply never published.
CREATE SEQUENCE deposit_address_index_seq AS BIGINT START WITH 0 MINVALUE 0;

ALTER TABLE accounts
    ADD COLUMN deposit_address  TEXT,
    ADD COLUMN derivation_index BIGINT;

-- Two addresses colliding would merge two users' funds, and one index serving
-- two accounts would do the same, so both are unique at the database level.
CREATE UNIQUE INDEX accounts_deposit_address_key ON accounts (deposit_address);
CREATE UNIQUE INDEX accounts_derivation_index_key ON accounts (derivation_index);

-- A user account must have an address; a system account represents a
-- book-keeping counterparty and has no on-chain presence at all.
--
-- This constraint assumes no USER account predates it, which holds because P2
-- lands before any deployment. Against a live table the safe sequence is
-- different: add the column, backfill addresses from application code, then
-- add the constraint as NOT VALID and VALIDATE it separately, so the table is
-- never locked while every row is checked.
ALTER TABLE accounts
    ADD CONSTRAINT accounts_address_matches_type CHECK (
        (type = 'USER' AND deposit_address IS NOT NULL AND derivation_index IS NOT NULL)
        OR (type = 'SYSTEM' AND deposit_address IS NULL AND derivation_index IS NULL)
    );

-- Addresses are stored EIP-55 checksummed, which the constraint enforces only
-- loosely: the point is to reject anything that is not a 20-byte hex address
-- before it reaches the chain layer.
ALTER TABLE accounts
    ADD CONSTRAINT accounts_deposit_address_format CHECK (
        deposit_address IS NULL OR deposit_address ~ '^0x[0-9a-fA-F]{40}$'
    );
