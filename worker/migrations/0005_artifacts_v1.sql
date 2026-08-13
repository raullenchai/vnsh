PRAGMA foreign_keys = ON;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','changes_requested','approved')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private')),
  current_version INTEGER NOT NULL DEFAULT 1,
  current_object_key TEXT NOT NULL,
  current_size INTEGER NOT NULL,
  history_size INTEGER NOT NULL DEFAULT 0,
  history_versions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX artifacts_owner_updated ON artifacts(owner_id, updated_at DESC);
CREATE INDEX artifacts_owner_status_updated ON artifacts(owner_id, status, updated_at DESC);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),
  change_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE artifact_access (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK(principal_type IN ('user','agent')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','editor','reviewer','owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, principal_type, principal_id)
);
