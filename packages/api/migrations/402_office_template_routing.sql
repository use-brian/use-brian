-- Mutable, human-reviewable routing metadata for an Office template draft.
-- Published versions keep the validated recipes inside their immutable bundle.

BEGIN;

ALTER TABLE office_templates
  ADD COLUMN draft_routing JSONB
  CHECK (draft_routing IS NULL OR jsonb_typeof(draft_routing) = 'object');

COMMIT;
