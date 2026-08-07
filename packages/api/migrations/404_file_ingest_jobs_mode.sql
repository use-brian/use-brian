-- 404_file_ingest_jobs_mode.sql  (OPEN table -> use-brian/packages/api/migrations/)
--
-- Provenance flag on the async file-ingest queue: which boundary enqueued the
-- job, and therefore whether the worker may spend a model distill on it.
--
--   'explicit' — the user asked for this file to be ingested (POST /api/files/ingest,
--                POST /api/files/:fileId/ingest). PDFs / images are distilled to
--                text before chunking, exactly as the old synchronous ingest route
--                did before it moved onto this queue.
--   'silent'   — artifact promotion of a chat attachment / large paste
--                (files/artifact-promote.ts). Store-only for PDFs / images: the
--                user never asked for a distill, so the queue must not spend one.
--                This is the pre-402 behavior for every row, hence the default.
--
-- Before this column the worker had no distill port at all, so 'explicit' jobs
-- silently degraded PDFs and images to store-only. The column is what lets the
-- port be wired without changing what the silent path costs.
--
-- See docs/architecture/brain/file-artifacts.md -> "Async ingest".
--
-- Filenames are globally unique across BOTH migration dirs (one shared
-- _migrations table). This landed as 402 and was renumbered to 404: the office
-- work took 402 and 403 in parallel, and a duplicate prefix is exactly what the
-- graded `migrations` check exists to catch. Never applied under the old name.
-- Next free is 405.

BEGIN;

ALTER TABLE file_ingest_jobs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'silent'
    CHECK (mode IN ('explicit', 'silent'));

COMMIT;
