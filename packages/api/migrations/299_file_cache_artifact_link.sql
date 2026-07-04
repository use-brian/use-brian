-- 299_file_cache_artifact_link.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Large-content-artifacts §Phase 2.3: a transient chat attachment that was
-- silently promoted to a durable workspace_files artifact carries the link, so
-- the chat attach seam can render the artifact manifest (id + section count)
-- from the CachedFile row with zero extra store wiring. ON DELETE SET NULL:
-- deleting the artifact degrades the cache row back to the plain
-- readFileContent pointer, never breaks it.
--
-- Latest applied migration is 298 (file_ingest_jobs). Filenames are globally
-- unique across BOTH migration dirs (one shared _migrations table).

BEGIN;

ALTER TABLE file_cache
  ADD COLUMN artifact_file_id UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  ADD COLUMN artifact_segment_count INT;

COMMIT;
