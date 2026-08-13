PRAGMA foreign_keys = ON;

CREATE TABLE artifact_capabilities (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('read','edit')),
  label TEXT,
  created_by_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX artifact_capabilities_artifact ON artifact_capabilities(artifact_id, revoked_at, created_at DESC);
