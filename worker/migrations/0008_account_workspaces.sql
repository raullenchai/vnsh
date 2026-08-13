PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, slug)
);
CREATE UNIQUE INDEX workspaces_one_default ON workspaces(owner_id) WHERE is_default=1;
CREATE INDEX workspaces_owner_updated ON workspaces(owner_id, updated_at DESC);

INSERT INTO workspaces(id,owner_id,name,slug,is_default,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'Personal','personal',1,created_at,created_at FROM users;

ALTER TABLE artifacts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT;
UPDATE artifacts SET workspace_id=(SELECT id FROM workspaces WHERE owner_id=artifacts.owner_id AND is_default=1);
CREATE INDEX artifacts_workspace_updated ON artifacts(workspace_id, updated_at DESC);
