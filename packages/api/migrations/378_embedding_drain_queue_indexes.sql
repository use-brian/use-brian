-- 378_embedding_drain_queue_indexes.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Drain-queue index for the embedding worker's claim
-- (docs/architecture/brain/embeddings.md §"Worker priority queue").
--
-- The claim selects `embedding IS NULL AND embedding_failed_at IS NULL`
-- oldest-first by created_at. No embedded table carried an index for that
-- predicate, so every 30s tick planned as:
--
--   Limit -> LockRows -> Sort (rows=473605 width=1139) -> Seq Scan on <table>
--
-- That is a full-table scan plus a sort of every unembedded row (carrying
-- the embed text, width 1139) just to take LIMIT 100 off the top. It stayed
-- invisible while the embedded tables were small and became an outage on
-- 2026-07-28, when email_archive_segments reached 528k rows / 5.6 GB with
-- 415k unembedded (the IMAP mailbox connector backfill, migration 359):
-- each claim took 5-20 minutes against shared_buffers=128MB / work_mem=4MB
-- on db-f1-micro. Because the claim runs inside the open transaction that
-- holds the row lease, every stuck claim pinned a pooled connection, claims
-- outlived their 30s tick and stacked, and all 25 Cloud SQL slots were
-- consumed -- every user-facing route 500'd with
-- "remaining connection slots are reserved for roles with privileges of the
-- pg_use_reserved_connections role" / pg-pool "timeout exceeded when trying
-- to connect".
--
-- Partial index on the exact claim predicate: only unembedded rows are
-- indexed, so it is a fraction of the table and shrinks toward empty as the
-- backlog drains. `created_at` is the key so both halves of the split claim
-- (recent-first, then the rest -- see embedding-store.ts) are bounded index
-- scans rather than sorts. The CASE priority expression is deliberately NOT
-- indexed: it contains now(), which is not IMMUTABLE and cannot appear in an
-- index expression -- which is why the claim was split into two range scans
-- instead.
--
-- Every drainable primitive gets the index, not just the table that broke:
-- they share one claim SQL, so any embedded table that grows large enough
-- reproduces the same outage. `episodes` is excluded (no embedding column --
-- it is the one EMBEDDED_PRIMITIVE that DRAINABLE_PRIMITIVES filters out).
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- file deliberately has no BEGIN/COMMIT wrapper; migrate.ts detects
-- CONCURRENTLY-without-BEGIN and runs each statement separately. Building
-- concurrently keeps the drain and all inbound writes online during the
-- build, which matters because the largest table is the one still ingesting.
--
-- Latest applied migration is 377 (task_guardrails). Filenames are
-- globally unique across BOTH migration dirs (one shared _migrations table).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_embed_queue
  ON memories (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_embed_queue
  ON entities (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kb_chunks_embed_queue
  ON kb_chunks (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_files_embed_queue
  ON workspace_files (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcript_segments_embed_queue
  ON transcript_segments (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_segments_embed_queue
  ON file_segments (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_archive_segments_embed_queue
  ON email_archive_segments (created_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;
