-- 298_file_ingest_jobs.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Async file-ingest queue (large-content-artifacts §Phase 2.2). A large document
-- or paste is filed synchronously into workspace_files (+ GCS bytes) and a row is
-- enqueued here; the file-ingest worker on sidanclaw-api-workers drains it:
-- claim -> readBytes -> parse -> indexFileArtifact (chunk into file_segments)
-- -> Pipeline B (entity/fact extraction, episode content_ref -> the artifact)
-- -> stamp source_episode_id -> done. This keeps parse/chunk/decompose off the
-- HTTP request thread. Mirrors 288_recording_jobs.sql.
--
-- System-only queue: every access is via the owner pool (query(), RLS-open) --
-- the boundary enqueue (after its own membership check) and the worker drain. RLS
-- is enabled with NO member policy so the app (RLS-enforced) pool cannot touch it;
-- members never read the queue directly. See docs/plans/large-content-artifacts.md.
--
-- Latest applied migration is 297 (file_segments). Filenames are globally unique
-- across BOTH migration dirs (one shared _migrations table); next free is 299.

BEGIN;

CREATE TABLE file_ingest_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         UUID NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,  -- artifact anchor
  workspace_id    UUID NOT NULL,
  acting_user_id  UUID NOT NULL,        -- the uploader; the worker reads the file
                                        -- + attributes the derived episode as this user
  assistant_id    UUID,                 -- assistant in context at enqueue (NULL = none)
  source_label    TEXT NOT NULL DEFAULT 'upload',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claim oldest-pending-first.
CREATE INDEX idx_file_ingest_jobs_claim ON file_ingest_jobs (created_at) WHERE status = 'pending';

-- At most one ACTIVE (pending/processing) job per file -> idempotent enqueue
-- (a re-upload / double-tap while one is in-flight does not double-process).
CREATE UNIQUE INDEX idx_file_ingest_jobs_active ON file_ingest_jobs (file_id)
  WHERE status IN ('pending', 'processing');

ALTER TABLE file_ingest_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
