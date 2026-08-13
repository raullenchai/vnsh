CREATE TABLE device_logins (
  code TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX device_logins_expiry ON device_logins(expires_at);
