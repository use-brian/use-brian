-- 335_recordings.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- The recording as a first-class noun.
--
-- Until now a "recording" was an `episodes` row with `source_kind = 'recording'`
-- and everything else stuffed in the JSONB `source_ref`
-- ({fileId, gcsKey, fileName, mime, status}). That worked while a recording was
-- write-only, but every surface now being built wants a COLUMN:
--
--   * kind (memo/meeting) — the transcriber ladder ALREADY routes on it
--     (RECORDING_TRANSCRIBER_MEMO / _MEETING), but the worker hardcoded
--     `kind:'memo'` because there was nowhere to put the signal. A JSONB key with
--     no CHECK is how you get 'Meeting', 'meeting ', and null in prod.
--   * duration_ms — ffprobed THREE times (estimate, process pre-flight, worker)
--     and persisted zero times; a list UI would re-probe on every render.
--   * bytes / delete_after — quota accounting and a retention sweeper need a
--     scan, and a JSONB sweeper is a full table scan of `episodes`.
--   * transcript_file_id / media_file_id — real FKs to the stored artifacts.
--   * a list UI — ORDER BY created_at DESC WHERE status='processed' over
--     `source_ref->>'status'` needs an expression index per filter.
--
-- THE ID TRICK. `recordings.id` IS the anchor Episode's id — the PK is itself the
-- FK to episodes(id). So this is a WIDENING, not a re-pointing: every existing
-- reference keeps resolving with no rewrite and no backfill of foreign keys —
--   transcript_segments.recording_id -> episodes(id)   (migration 280)
--   recording_jobs.recording_id                        (migration 288)
--   blueprint_records.source_id                        (migration 307)
--   usage_tracking / surcharges recordingId
--   saved_views.anchor_key 'recording-synthesis:<id>'
-- ...all hold the same UUID. Making the PK the FK (rather than carrying a
-- separate `episode_id` column holding the same value) enforces the identity in
-- the schema instead of by convention, and cannot drift.
--
-- The anchor Episode SURVIVES and stays the provenance anchor — facts point at
-- episodes, so a recording-sourced fact and a Slack-sourced fact stay uniform.
-- `source_ref` also survives as a DUAL-WRITE for exactly one release: this table
-- is authoritative on READ from day one; the source_ref writes are removed only
-- after a grep confirms zero readers.
--
-- Next free migration number is 331 (latest applied is 330). Filenames are
-- globally unique across BOTH migration dirs (one shared _migrations table).

BEGIN;

CREATE TABLE recordings (
  -- The PK is the FK: recordings.id == the anchor episodes.id. See "THE ID
  -- TRICK" above. CASCADE so deleting the anchor Episode reaps the recording,
  -- matching transcript_segments.recording_id's existing behavior.
  id                 UUID PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id),

  title              TEXT,
  -- Routes the transcriber ladder (transcription.md §Kind routing). Defaults to
  -- 'memo', which is exactly what the worker hardcoded before this table existed.
  kind               TEXT NOT NULL DEFAULT 'memo' CHECK (kind IN ('memo', 'meeting')),
  -- The lifecycle the route + worker stamp (transcription.md §Status lifecycle).
  status             TEXT NOT NULL DEFAULT 'awaiting_upload'
                       CHECK (status IN ('awaiting_upload', 'queued', 'processing', 'processed', 'failed')),

  file_name          TEXT,
  mime               TEXT NOT NULL,
  gcs_key            TEXT NOT NULL,
  -- BYO-bucket recordings carry their own storage root; NULL = the platform
  -- bucket. The worker resolves the signing client from this
  -- (process-recording.ts resolveReadClient).
  storage_uri        TEXT,

  bytes              BIGINT,      -- media size; NULL until first probe
  duration_ms        BIGINT,      -- persisted ONCE (was ffprobed 3x, stored 0x)

  -- The stored artifacts. Both nullable: a recording is usable before either
  -- exists, and the transcript write is failure-isolated (a null degrades to
  -- pre-artifact behavior rather than blocking segments/entities/billing).
  transcript_file_id UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  media_file_id      UUID REFERENCES workspace_files(id) ON DELETE SET NULL,

  -- [{speaker, name?, contact_id?, email?}] — the diarized-speaker -> person
  -- resolution, filled by later phases.
  participants       JSONB NOT NULL DEFAULT '[]',

  truncated          BOOLEAN NOT NULL DEFAULT false,
  last_error         TEXT,
  -- Retention sweeper input; NULL = keep. Audio is currently retained forever by
  -- accident (nothing deletes a recordings/ key) — this is where a policy lands.
  delete_after       TIMESTAMPTZ,

  -- universal columns, mirroring transcript_segments (280) so the visibility /
  -- sensitivity / bi-temporal predicates the retrieval layer shares can resolve
  -- against this table too.
  user_id            UUID,
  assistant_id       UUID,
  sensitivity        TEXT NOT NULL DEFAULT 'internal',
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  tags               TEXT[],
  metadata           JSONB,
  created_by_user_id UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to           TIMESTAMPTZ,
  retracted_at       TIMESTAMPTZ,

  -- visibility double CHECK (mirrors transcript_segments_visibility_check)
  CONSTRAINT recordings_visibility_check CHECK (user_id IS NOT NULL OR assistant_id IS NOT NULL)
);

-- The list read: newest-first within a workspace, live rows only.
CREATE INDEX idx_recordings_ws_created ON recordings (workspace_id, created_at DESC)
  WHERE valid_to IS NULL AND retracted_at IS NULL;
CREATE INDEX idx_recordings_ws_status ON recordings (workspace_id, status);
-- Retention sweep: partial so it stays tiny while delete_after is mostly NULL.
CREATE INDEX idx_recordings_sweep ON recordings (delete_after) WHERE delete_after IS NOT NULL;

-- Backfill every existing recording Episode, PRESERVING the id.
--
-- Status is inferred from GROUND TRUTH, not from `source_ref->>'status'`. That
-- field is a claim, and it is demonstrably unreliable: the only writer of the
-- terminal state swallows its own failure
-- (`mergeEpisodeSourceRef(..., {status:'processed'}).catch(...)` in
-- apps/api/src/index.ts), and the route only advances 'awaiting_upload' ->
-- 'queued' when the upload came through the HTTP path. Locally, a fully
-- transcribed 96-minute recording with 1067 transcript_segments still read
-- 'awaiting_upload'. Propagating that into a CHECK'd column would launder a
-- known-wrong value into the new source of truth.
--
-- So: EXISTING SEGMENTS WIN. If a recording has transcript_segments it was
-- processed, whatever source_ref claims. Otherwise trust a valid source_ref
-- status, and fall back to the table default ('awaiting_upload' = nothing
-- happened) rather than guessing 'processed' for a recording that may never have
-- been uploaded at all.
--
-- A missing gcsKey is reconstructed from the documented key scheme
-- (buildStorageKey -> '<workspace_id>/recordings/<fileId>').
INSERT INTO recordings (
  id, workspace_id, mime, gcs_key, storage_uri, file_name, status,
  user_id, assistant_id, sensitivity, compartments,
  created_by_user_id, created_at
)
SELECT
  e.id,
  e.workspace_id,
  COALESCE(e.source_ref->>'mime', 'audio/mpeg'),
  COALESCE(
    e.source_ref->>'gcsKey',
    e.workspace_id::text || '/recordings/' || COALESCE(e.source_ref->>'fileId', e.id::text)
  ),
  e.source_ref->>'storageUri',
  e.source_ref->>'fileName',
  CASE
    WHEN EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.recording_id = e.id)
      THEN 'processed'
    WHEN e.source_ref->>'status' IN ('awaiting_upload', 'queued', 'processing', 'processed', 'failed')
      THEN e.source_ref->>'status'
    ELSE 'awaiting_upload'
  END,
  e.user_id,
  e.assistant_id,
  e.sensitivity,
  e.compartments,
  e.created_by_user_id,
  e.created_at
FROM episodes e
WHERE e.source_kind = 'recording'
  -- The visibility double is NOT NULL-checked on episodes the same way; skip any
  -- row that would violate recordings_visibility_check rather than fail the
  -- migration. Such a row is unreachable by RLS anyway.
  AND (e.user_id IS NOT NULL OR e.assistant_id IS NOT NULL)
ON CONFLICT (id) DO NOTHING;

-- RLS: workspace-membership policy, mirroring transcript_segments_workspace_member.
-- The NULL-SAFE current_setting two-arg form is load-bearing: the single-arg form
-- throws "unrecognized configuration parameter" when the GUC is unset
-- (system-pool / worker path); (..., true) returns NULL -> zero rows.
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
CREATE POLICY recordings_workspace_member ON recordings
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
