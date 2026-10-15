-- User authentication.
--
-- Until now any caller who knew an account id could move its money: the API
-- trusted whoever asked. A user now signs in with a password and receives a
-- session token, and every route that touches an account checks the session
-- belongs to its owner.
--
-- Passwords are stored as scrypt hashes, salted per user, in a self-describing
-- format (scrypt$N$r$p$salt$hash) so the cost can be raised later without
-- breaking existing ones. Session tokens are stored only as their SHA-256: a
-- leaked sessions table hands out nothing that signs a request.

ALTER TABLE users
    -- Null for users created before sign-in existed, and for test fixtures:
    -- such a user simply cannot sign in.
    ADD COLUMN password_hash TEXT CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9a-f]+\$[0-9a-f]+$');

CREATE TABLE auth_sessions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id),
    token_hash  TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
