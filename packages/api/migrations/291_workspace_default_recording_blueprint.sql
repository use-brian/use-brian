-- 291_workspace_default_recording_blueprint.sql
-- Workspace-level default recording blueprint (structural-synthesis Tier-2).
--
-- A workspace can name a default BLUEPRINT (a workspace_page_templates row that
-- carries an `extraction` spec) that every recording auto-uses when no blueprint
-- is explicitly picked. The value is a page-template id (zero built-ins exist) —
-- the recording synthesizer already resolves a template id via its
-- pageTemplateStore document-blueprint branch. NULL = no default (ingest-only).
--
-- The selection ladder becomes `explicit pick ?? workspace default ?? none`,
-- resolved at the enqueue edges (channel intake), never the worker.
-- ON DELETE SET NULL: deleting the template nulls the default (graceful
-- staleness, decision D5).
--
-- See docs/plans/workspace-default-recording-blueprint.md §2 (D1) and
-- docs/architecture/brain/structural-synthesis.md.

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS default_recording_blueprint_id UUID
    REFERENCES workspace_page_templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN workspaces.default_recording_blueprint_id IS
  'Workspace default recording blueprint — a workspace_page_templates id carrying an extraction spec. NULL = ingest-only (migration 291).';

COMMIT;
