-- The Merkle sum tree over each snapshot's liabilities.
--
-- Every account gets a fresh random salt per snapshot, folded into its leaf.
-- Account ids are sequential, so without one anybody could hash each id with
-- each plausible balance until a leaf matched; and with the same salt every
-- time, a user's leaves could be linked from one snapshot to the next. The salt
-- goes only to the user, inside their proof.
--
-- The tree itself is not stored: it is rebuilt from these rows, which fix it
-- completely, and checked against the root recorded here.

ALTER TABLE reserve_liabilities
    ADD COLUMN salt TEXT CHECK (salt ~ '^0x[0-9a-f]{64}$');

-- The root's sum is the snapshot's liabilities, so only its hash is new.
-- Snapshots taken before this migration have no tree.
ALTER TABLE reserve_snapshots
    ADD COLUMN root_hash TEXT CHECK (root_hash ~ '^0x[0-9a-f]{64}$');
