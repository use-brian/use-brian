-- 284_blueprint_extraction_spec.sql
-- Turn a plain page template into a BLUEPRINT: an optional `extraction` spec
-- ({ sections:[{heading,instruction,outputType}], capture:[...] }) that the
-- structural-synthesis engine fills from a source. NULL = a plain skeleton.
-- See docs/architecture/brain/structural-synthesis.md -> "The blueprint object".

BEGIN;

ALTER TABLE workspace_page_templates
  ADD COLUMN IF NOT EXISTS extraction JSONB;

COMMENT ON COLUMN workspace_page_templates.extraction IS
  'Blueprint extraction spec { sections, capture }. NULL = plain template skeleton (migration 284).';

COMMIT;
