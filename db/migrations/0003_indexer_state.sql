-- Where the chain scanner left off.
--
-- Without this the indexer would rescan from genesis on every restart, or
-- worse, resume from "now" and silently miss every deposit that arrived while
-- it was down.

CREATE TABLE indexer_state (
    -- One row per logical scanner, so a second indexer (a different token, a
    -- different chain) can be added later without colliding.
    id                 TEXT PRIMARY KEY,

    -- The highest block whose logs have been fully processed. The next scan
    -- starts at last_scanned_block + 1.
    last_scanned_block BIGINT NOT NULL CHECK (last_scanned_block >= 0),

    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
