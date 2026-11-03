-- Single administrator account and its login sessions.
-- The password is stored only as a salted scrypt hash; sessions store only a SHA-256 of the token.
CREATE TABLE IF NOT EXISTS admin_account (
  id smallint PRIMARY KEY CHECK (id = 1),
  username text NOT NULL,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);
