-- Nonce allocation for the wallet that signs outgoing transactions.
--
-- Every transaction from an account carries a strictly sequential nonce. Two
-- workers that both ask the node for eth_getTransactionCount receive the same
-- answer, sign two transactions with the same nonce, and the node keeps one --
-- the other withdrawal silently disappears. So nonces are handed out by the
-- database, which can serialise the request, rather than by the chain, which
-- cannot.
--
-- Gaps are worse than duplicates. A nonce that is allocated but never broadcast
-- blocks every later nonce behind it, freezing withdrawals entirely, which is
-- why allocation happens inside the caller's transaction: a rollback puts the
-- nonce back.

CREATE TABLE hot_wallets (
    id         TEXT PRIMARY KEY,
    address    TEXT NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),

    -- The next nonce to hand out. Equal to the account's transaction count on
    -- chain whenever nothing is in flight.
    next_nonce BIGINT NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
