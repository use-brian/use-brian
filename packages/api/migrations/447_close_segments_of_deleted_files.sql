-- 447: close the `file_segments` left inside the current window by files that
-- are already outside it.
--
-- The Brain drawer's delete soft-closed `workspace_files` only. Retrieval reads
-- the SEGMENT's own bi-temporal window (`visibilityPredicate` in
-- retrieval-store.ts never joins the parent row), so every file deleted before
-- the cascade landed is still fully searchable through `searchFileContent`,
-- `readFileSegmentRange` and the brain `file_segment` arm - the user deleted it
-- and Brian keeps quoting it.
--
-- The code fix (`closeWorkspaceFileSegmentsSystem`, wired into the delete route)
-- only covers deletes from here on; nothing else ever revisits an already-closed
-- file, so this backfill is the only way those users get the delete they asked
-- for. It is the invariant stated as SQL - a file outside the current window has
-- no segments inside it - so it is safe to re-run and correct for every closing
-- reason. Supersession and the BYO staleness sweep already cascade, so their
-- segments are closed and the predicate skips them.
--
-- `valid_to` is set to the PARENT's `valid_to`, not `now()`, so an `as_of` read
-- of a past moment still sees the segments that were live at that moment.

BEGIN;

UPDATE file_segments fs
   SET valid_to = wf.valid_to
  FROM workspace_files wf
 WHERE fs.file_id = wf.id
   AND wf.valid_to IS NOT NULL
   AND fs.valid_to IS NULL;

COMMIT;
