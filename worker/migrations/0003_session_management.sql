ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE sessions ADD COLUMN label TEXT NOT NULL DEFAULT 'Browser session';
ALTER TABLE sessions ADD COLUMN last_used_at TEXT;
UPDATE sessions SET id=lower(hex(randomblob(16))), last_used_at=created_at WHERE id IS NULL;
CREATE UNIQUE INDEX sessions_id ON sessions(id);
