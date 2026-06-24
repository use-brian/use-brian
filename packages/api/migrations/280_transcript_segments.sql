-- 280_transcript_segments.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Long-recording transcript segmentation + retrieval substrate
-- (recording-to-brain Phase 3). A recording's transcript is packed into
-- ~60-90s / ~1-1.5K-char segments, each embedded and retrievable on demand via
-- the dedicated searchRecording scope (NOT in KNOWN_SCOPES, so it never floods
-- general searchBrain). Carries the full kb_chunks universal-column set so the
-- shared vector projection's columns exist. See docs/plans/recording-to-brain.md.
--
-- Next free OPEN migration number is 280 (latest applied is 279). Filenames are
-- globally unique across BOTH migration dirs (one shared _migrations table).

BEGIN;

CREATE TABLE transcript_segments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id),
  recording_id       UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,  -- provenance anchor
  transcript_file_id UUID REFERENCES workspace_files(id),                      -- raw transcript bytes
  segment_index      INT  NOT NULL,
  start_ms           BIGINT NOT NULL,
  end_ms             BIGINT NOT NULL,
  speaker            TEXT,
  speaker_ids        TEXT[],
  segment_text       TEXT NOT NULL CHECK (length(segment_text) > 0),
  utterance_refs     JSONB,

  -- universal columns (visibility double + sensitivity + trust + bi-temporal),
  -- copied verbatim from kb_chunks (000_open_schema_v1.sql) so the shared vector
  -- projection's columns (source, verified_by_user_id, valid_from, retracted_at)
  -- EXIST even though searchRecording uses a dedicated handler. Omitting any of
  -- these would make a runVectorScope-shaped query throw "column does not exist"
  -- and embedAndSearchVector would soft-fail silently to [].
  user_id            UUID,
  assistant_id       UUID,
  source             TEXT NOT NULL DEFAULT 'recording',
  sensitivity        TEXT NOT NULL DEFAULT 'internal',
  compartments       TEXT[] NOT NULL DEFAULT '{}',
  tags               TEXT[],
  metadata           JSONB,
  verified_by_user_id UUID,
  verified_at        TIMESTAMPTZ,
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to           TIMESTAMPTZ,
  superseded_by      UUID,
  retracted_at       TIMESTAMPTZ,
  retracted_by_user_id UUID,
  retracted_reason   TEXT,
  created_by_user_id UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- visibility double CHECK (mirrors kb_chunks_visibility_check)
  CONSTRAINT transcript_segments_visibility_check CHECK (user_id IS NOT NULL OR assistant_id IS NOT NULL),

  -- embedding scaffold (six-column set, identical to every embedded primitive)
  embedding                VECTOR(768),
  embedding_model_id       TEXT,
  content_hash             TEXT,
  embedding_failed_at      TIMESTAMPTZ,
  embedding_failure_reason TEXT,
  embedding_updated_at     TIMESTAMPTZ,

  UNIQUE (recording_id, segment_index)
);

CREATE INDEX idx_transcript_segments_recording ON transcript_segments (recording_id, segment_index);

-- HNSW build is fine INSIDE BEGIN/COMMIT (only CREATE INDEX CONCURRENTLY must
-- omit the transaction wrapper). Mirrors kb_chunks' HNSW.
CREATE INDEX idx_transcript_segments_embedding ON transcript_segments
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- RLS: workspace-membership policy, mirroring kb_chunks_workspace_member.
-- The NULL-SAFE current_setting two-arg form is load-bearing: the single-arg
-- form throws "unrecognized configuration parameter" when the GUC is unset
-- (system-pool / unauthenticated path); (..., true) returns NULL -> zero rows.
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY transcript_segments_workspace_member ON transcript_segments
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
