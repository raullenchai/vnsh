PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, tier TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL);
CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX magic_links_expiry ON magic_links(expires_at);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('workspace','artifact')), visibility TEXT NOT NULL CHECK(visibility IN ('encrypted','public')), size INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, plaintext_name TEXT);
CREATE INDEX documents_owner_updated ON documents(user_id, updated_at DESC);
