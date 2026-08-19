-- 445: workspace_files — scope the (workspace_id, path) uniqueness to the
-- CURRENT bi-temporal version.
--
-- `workspace_files` is bi-temporal (`valid_to IS NULL` = current version), but
-- the legacy constraint from mig 119 (`workspace_files_workspace_id_path_key`)
-- was unscoped, so a row that LEFT the current window still owned its path
-- forever: soft-deleted from the Brain drawer, superseded by a staged write, or
-- retracted by the BYO-storage staleness sweep.
--
-- Every current-version read filters `valid_to IS NULL`, so such a row was
-- invisible to the Brain list, invisible to the upload pre-checks
-- (`getWorkspaceFileByPath` in both `filesApi.persist` and the chunked-upload
-- start/complete gates) — and still fatal at INSERT. Re-uploading a file the
-- user had just deleted failed with "A file with that name already exists",
-- permanently, with nothing on any surface to explain it. The same constraint
-- is what blocked path-stable supersession in `supersedeWorkspaceFile`.
--
-- No dedup pre-pass is needed: the unscoped constraint guarantees no two rows
-- share (workspace_id, path) at all, so the narrower partial index cannot find
-- a conflict among current rows.

BEGIN;

ALTER TABLE workspace_files
  DROP CONSTRAINT IF EXISTS workspace_files_workspace_id_path_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_files_current_path
  ON workspace_files (workspace_id, path)
  WHERE valid_to IS NULL;

COMMIT;
