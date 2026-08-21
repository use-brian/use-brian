-- Failed embeddings are delayed work, not terminal rows. The normal drain
-- index excludes them, so the bounded retry lane needs its own oldest-first
-- partial index. CONCURRENTLY avoids blocking writes on the large corpora.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_embedding_retry
  ON memories (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_embedding_retry
  ON entities (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kb_chunks_embedding_retry
  ON kb_chunks (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_files_embedding_retry
  ON workspace_files (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transcript_segments_embedding_retry
  ON transcript_segments (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_segments_embedding_retry
  ON file_segments (created_at DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_archive_segments_embedding_retry
  ON email_archive_segments (valid_from DESC, embedding_failed_at)
  WHERE embedding IS NULL AND embedding_failed_at IS NOT NULL;
