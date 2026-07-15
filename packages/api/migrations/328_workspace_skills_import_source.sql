-- Skill import provenance (docs/architecture/engine/skill-system.md →
-- "Importing skills (GitHub / URL)" → "Provenance + create-route extension").
-- Stamped at create when a skill draft came from the GitHub/URL importer:
-- { kind, owner?, repo?, path?, ref?, sha?, url? }. Nothing reads it at
-- runtime today; it exists to enable a later upstream re-sync/diff.

BEGIN;

ALTER TABLE workspace_skills ADD COLUMN import_source JSONB;

COMMIT;
