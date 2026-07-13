BEGIN;

-- Interactive-write provenance anchor for tasks + entities (2026-07-10 source
-- descriptor, docs/architecture/brain/data-model.md → "Provenance pattern",
-- docs/architecture/brain/corrections.md → "Source descriptor").
--
-- Extraction writes (Pipeline B) anchor on source_episode_id; interactive
-- writes (chat tools, workflow runs) create no Episode and had NOWHERE to
-- record the originating conversation for any primitive except memories —
-- chat saveTask / saveContact / saveCompany / saveDeal held context.sessionId
-- at call time and dropped it, so the Brain entry page's Source block read
-- "No source chat captured" for every task and CRM row ever created.
--
-- Nullable, no FK — deliberately matches memories.source_session_id: sessions
-- are prunable and the anchor is advisory (the explain route verifies the
-- session still exists before rendering messages). NULL on all pre-316 rows;
-- the read side falls back to source_episode_id, then to author + created_at.
ALTER TABLE public.tasks
  ADD COLUMN source_session_id uuid;

ALTER TABLE public.entities
  ADD COLUMN source_session_id uuid;

COMMIT;
