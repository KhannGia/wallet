-- A withdrawal that can never be broadcast is the worst failure this system
-- has: it holds a nonce, and every later transaction queues behind that nonce
-- forever. Counting the failures lets the worker give up on one and free the
-- slot instead of retrying it until someone notices.

ALTER TABLE chain_withdrawals
    ADD COLUMN broadcast_failures INTEGER NOT NULL DEFAULT 0;
