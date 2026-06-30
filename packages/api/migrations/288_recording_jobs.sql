-- 288_recording_jobs.sql — async recording-process queue (channel-media-ingest
-- Phase 2). Recording transcription moves OFF the inline HTTP request onto the
-- sidanclaw-api-workers service: the `/process` route enqueues a row here and the
-- recording-process worker drains it (claim → ffprobe → ffmpeg audio-extract →
-- ingestRecording). This removes the 300s Cloud-Run request-timeout + the
-- inline-OOM bound on large files.
--
-- System-only queue: every access is via the owner pool (`query()`, RLS-open) —
-- the route enqueue (after its own membership check) and the worker drain. RLS is
-- enabled with NO member policy so the app (RLS-enforced) pool cannot touch it;
-- members never read the queue directly. See docs/plans/channel-media-ingest.md.

BEGIN;

CREATE TABLE recording_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id    UUID NOT NULL,        -- the recording Episode id
  workspace_id    UUID NOT NULL,
  acting_user_id  UUID NOT NULL,        -- the recording's creator; the worker
                                        -- reads the Episode + attributes COGS /
                                        -- surcharge as this user
  blueprint_slug  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claim oldest-pending-first.
CREATE INDEX idx_recording_jobs_claim ON recording_jobs (created_at) WHERE status = 'pending';

-- At most one ACTIVE (pending/processing) job per recording → idempotent enqueue
-- (a double-tap on /process does not double-process).
CREATE UNIQUE INDEX idx_recording_jobs_active ON recording_jobs (recording_id)
  WHERE status IN ('pending', 'processing');

ALTER TABLE recording_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
