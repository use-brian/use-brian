-- 297_file_segments.sql  (OPEN table -> sidanclaw/packages/api/migrations/)
--
-- Large-content-artifacts segment substrate (docs/plans/large-content-artifacts.md
-- §Phase 1). A workspace file's parsed text is chunked into ~1.2-1.5K-char,
-- heading-aware segments, each embedded and retrievable via searchFileContent
-- (per-file search + ranged read) AND via the general search() `file_segment`
-- scope, capped per source artifact so one document never floods a results page.
-- Mirrors 280_transcript_segments.sql; carries the full kb_chunks
-- universal-column set so the shared vector projection's columns exist.
--
-- Latest applied migration is 296 (crm_entity_drop). Filenames are globally
-- unique across BOTH migration dirs (one shared _migrations table).

BEGIN;

CREATE TABLE file_segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  file_id       UUID NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,  -- artifact anchor
  segment_index INT  NOT NULL,
  -- Offsets into the canonical parsed text (after \r\n -> \n normalization).
  -- INVARIANT: content === normalizedText.slice(char_start, char_end), so
  -- re-chunking is verifiable and verbatim quoting possible.
  char_start    INT  NOT NULL,
  char_end      INT  NOT NULL,
  -- Markdown heading breadcrumb at this segment's position, outermost first
  -- (parsers emit Markdown for docx/xlsx/pptx; sheet/slide names arrive as
  -- headings). Prefixed into the embed text (embedding-store textExpr).
  heading_path  TEXT[] NOT NULL DEFAULT '{}',
  content       TEXT NOT NULL CHECK (length(content) > 0),

  -- universal columns (visibility double + sensitivity + trust + bi-temporal),
  -- copied verbatim from kb_chunks (000_open_schema_v1.sql) so the shared vector
  -- projection's columns (source, verified_by_user_id, valid_from, retracted_at)
  -- EXIST for runVectorScope-shaped queries. Values are inherited VERBATIM from
  -- the workspace_files parent row at chunk time (artifact-index).
  user_id            UUID,
  assistant_id       UUID,
  source             TEXT NOT NULL DEFAULT 'user',
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

  -- DELIBERATE DEVIATION from 280/kb_chunks: NO visibility-double CHECK.
  -- Segments inherit visibility verbatim from the workspace_files parent, and
  -- filesApi-written parents are legitimately NULL/NULL (= workspace-shared;
  -- workspace_files itself carries no such CHECK). Adding the CHECK would make
  -- shared artifacts unrepresentable. buildAccessPredicate treats NULL as
  -- axis-unrestricted, which is exactly the intended semantics.

  -- embedding scaffold (six-column set, identical to every embedded primitive)
  embedding                VECTOR(768),
  embedding_model_id       TEXT,
  content_hash             TEXT,
  embedding_failed_at      TIMESTAMPTZ,
  embedding_failure_reason TEXT,
  embedding_updated_at     TIMESTAMPTZ,

  UNIQUE (file_id, segment_index)
);

CREATE INDEX idx_file_segments_file ON file_segments (file_id, segment_index);

-- HNSW build is fine INSIDE BEGIN/COMMIT (only CREATE INDEX CONCURRENTLY must
-- omit the transaction wrapper). Mirrors kb_chunks' HNSW.
CREATE INDEX idx_file_segments_embedding ON file_segments
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- RLS: workspace-membership policy, mirroring kb_chunks_workspace_member.
-- NULL-SAFE current_setting two-arg form (single-arg throws when the GUC is
-- unset on the system-pool path; (..., true) returns NULL -> zero rows).
ALTER TABLE file_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_segments_workspace_member ON file_segments
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
