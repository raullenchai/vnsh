ALTER TABLE artifacts ADD COLUMN summary TEXT;
ALTER TABLE artifacts ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'document'
  CHECK(artifact_type IN ('document','report','code','app','handoff'));

ALTER TABLE artifact_versions ADD COLUMN source_ref TEXT;
ALTER TABLE artifact_versions ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE artifact_versions ADD COLUMN client_harness TEXT;
ALTER TABLE artifact_versions ADD COLUMN client_model TEXT;
