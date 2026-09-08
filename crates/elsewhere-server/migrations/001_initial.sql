CREATE TABLE tokens (
    id TEXT PRIMARY KEY NOT NULL,
    secret_hash BLOB NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER
        CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms)
) STRICT;

CREATE TABLE token_permissions (
    token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (length(permission) > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (token_id, permission)
) STRICT;
