-- Proposals to move reserves out of the multisig vault, and the owner
-- signatures collected for them before anything touches the chain.
--
-- Signatures are gathered here, off-chain, so owners can approve at their own
-- pace from their own devices. Only once a quorum exists is a single
-- transaction submitted -- the vault never sees a partial approval.

CREATE TYPE vault_proposal_status AS ENUM (
    'COLLECTING',  -- waiting for signatures
    'EXECUTED',    -- the vault performed the call
    'STALE',       -- the vault's nonce moved on; these signatures can never be used
    'EXPIRED'      -- the deadline passed first
);
-- There is deliberately no FAILED state. A reverted execute reverts everything,
-- the vault's nonce included, so the approval is still valid and can be
-- resubmitted -- once the vault is funded, say -- until its deadline. A
-- submission failure is recorded in `failure` and the proposal stays open.

CREATE TABLE vault_proposals (
    id              BIGSERIAL PRIMARY KEY,
    vault_address   TEXT NOT NULL CHECK (vault_address ~ '^0x[0-9a-fA-F]{40}$'),
    chain_id        BIGINT NOT NULL,

    to_address      TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-fA-F]{40}$'),

    -- Wei, and so a uint256. BIGINT tops out near 9.22 * 10^18, which is about
    -- 9.22 ether: a reserve transfer of ten would overflow it. 78 digits holds
    -- any uint256.
    value           NUMERIC(78, 0) NOT NULL CHECK (value >= 0),

    data            TEXT NOT NULL CHECK (data ~ '^0x([0-9a-fA-F]{2})*$'),

    -- The vault nonce these signatures cover. Every execution consumes one, so
    -- a proposal is only ever valid for exactly this position in the queue.
    nonce           BIGINT NOT NULL CHECK (nonce >= 0),
    deadline        BIGINT NOT NULL,

    -- Computed off-chain from the same EIP-712 definition the contract uses.
    -- A mismatch would collect signatures the vault then rejects.
    digest          TEXT NOT NULL UNIQUE CHECK (digest ~ '^0x[0-9a-f]{64}$'),
    threshold       INTEGER NOT NULL CHECK (threshold > 0),

    status          vault_proposal_status NOT NULL DEFAULT 'COLLECTING',
    transaction_hash TEXT,
    failure         TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ
);

-- Only one proposal may be collecting for a given vault nonce. Two would be
-- racing for the same slot, and whichever lost would have gathered its
-- signatures for nothing.
CREATE UNIQUE INDEX vault_proposals_one_open_per_nonce
    ON vault_proposals (vault_address, nonce)
    WHERE status = 'COLLECTING';

CREATE TABLE vault_signatures (
    proposal_id BIGINT NOT NULL REFERENCES vault_proposals (id),

    -- Stored lower-case so the primary key catches the same owner signing
    -- twice regardless of how the address was written.
    signer      TEXT NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
    signature   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (proposal_id, signer)
);
