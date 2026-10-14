-- Where each snapshot's root was published.
--
-- A root that only the platform serves could be a different root for every
-- user who asks. Published in the registry contract, there is one sequence of
-- roots, the same for everyone. A snapshot that failed to publish keeps the
-- reason; the next one is published in its place, since the registry only
-- moves forwards.

ALTER TABLE reserve_snapshots
    ADD COLUMN registry_address TEXT CHECK (registry_address ~ '^0x[0-9a-fA-F]{40}$'),
    ADD COLUMN attestation_id   NUMERIC(78, 0) CHECK (attestation_id >= 0),
    ADD COLUMN publish_tx       TEXT CHECK (publish_tx ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN published_at     TIMESTAMPTZ,
    ADD COLUMN publish_failure  TEXT,
    ADD CONSTRAINT reserve_snapshots_published_completely CHECK (
        (attestation_id IS NULL) = (registry_address IS NULL)
        AND (attestation_id IS NULL) = (published_at IS NULL)
    );
