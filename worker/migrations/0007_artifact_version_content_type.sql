ALTER TABLE artifact_versions ADD COLUMN content_type TEXT;
UPDATE artifact_versions
SET content_type=(SELECT content_type FROM artifacts WHERE artifacts.id=artifact_versions.artifact_id)
WHERE content_type IS NULL;
