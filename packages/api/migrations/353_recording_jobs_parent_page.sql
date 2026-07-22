-- Recording-brief destination (recording-to-brain / structural-synthesis).
--
-- Until now a blueprint brief authored from an uploaded recording was always
-- created at the WORKSPACE ROOT: the recording synthesizer passed no parent, so
-- `createDraft` inserted with `nest_parent_id = NULL`. There was nowhere to put
-- a destination even if the UI asked for one — `recording_jobs` carried only
-- `blueprint_slug`.
--
-- This column carries the user's pre-flight choice from the confirm dialog
-- through the async worker to `createDraft({ nestParentId })`.
--
-- NULL keeps the existing behaviour (file at the workspace root), so every
-- in-flight row and every caller that does not pass a destination is unchanged.
--
-- ON DELETE SET NULL, not CASCADE: deleting the destination page must never
-- delete a queued recording job (the audio is already paid for). The brief
-- degrades to the workspace root instead.
BEGIN;

ALTER TABLE recording_jobs
  ADD COLUMN parent_page_id uuid REFERENCES saved_views(id) ON DELETE SET NULL;

COMMENT ON COLUMN recording_jobs.parent_page_id IS
  'Destination page for the synthesized brief (nest_parent_id). NULL = workspace root.';

COMMIT;
