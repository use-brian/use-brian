-- Native Agent Skills bundles: progressive-disclosure resources, stable
-- source digests, and searchable path-preserving materialization.
BEGIN;

ALTER TABLE workspace_skills
  ADD COLUMN IF NOT EXISTS bundle_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_digest TEXT;

ALTER TABLE workspace_skills
  DROP CONSTRAINT IF EXISTS workspace_skills_bundle_version_check;
ALTER TABLE workspace_skills
  ADD CONSTRAINT workspace_skills_bundle_version_check
  CHECK (bundle_version IN (1, 2));

ALTER TABLE workspace_skill_files
  ADD COLUMN IF NOT EXISTS path TEXT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (
      to_tsvector('simple', COALESCE(description, '') || ' ' || content)
    ) STORED;

ALTER TABLE workspace_skill_files
  DROP CONSTRAINT IF EXISTS workspace_skill_files_kind_check;
ALTER TABLE workspace_skill_files
  ADD CONSTRAINT workspace_skill_files_kind_check
  CHECK (kind IN ('reference', 'asset', 'template', 'script'));

UPDATE workspace_skill_files
SET path = CASE
  WHEN name ~ '^(references|assets|templates|scripts)/' THEN name
  WHEN kind = 'reference' THEN 'references/' || name
  WHEN kind = 'asset' THEN 'assets/' || name
  WHEN kind = 'template' THEN 'templates/' || name
  WHEN kind = 'script' THEN 'scripts/' || name
END
WHERE path IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_skill_files_path
  ON workspace_skill_files (workspace_skill_id, path)
  WHERE path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_skill_files_search
  ON workspace_skill_files USING GIN (search_vector);

INSERT INTO entity_link_types (edge_type, description)
VALUES
  ('contains', 'skill -> skill_file membership derived from a native skill bundle'),
  ('uses_skill', 'skill -> skill dependency derived from an explicit relative SKILL.md link'),
  ('references_resource', 'skill_file -> entity/memory/kb_chunk reference derived from explicit ids')
ON CONFLICT (edge_type) DO NOTHING;

COMMIT;
