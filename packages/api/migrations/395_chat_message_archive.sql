-- 395_chat_message_archive.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Local provider-neutral interactive-chat archive and search projection.
-- `brian-message-store` consumes ub.ingest.append.v1 and writes these tables;
-- the platform remains the schema owner and supplies embeddings, enrichment,
-- retrieval, RLS projection, and agent tools.
--
-- Person-compartmented like email_archive (migration 359): chat history belongs
-- to one owner even inside a shared workspace. The immutable raw row and the
-- derived search segment stay separate so embedding / Pipeline B failures can
-- never affect append durability.
--
-- PGLite compatibility is required: local boot applies this migration through
-- migrate-pglite.ts with pgvector + pg_trgm already loaded.
--
-- See docs/architecture/integrations/chat-message-store.md.

BEGIN;

CREATE TABLE chat_archive_messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id              UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id            UUID NOT NULL,
  source                   TEXT NOT NULL CHECK (length(source) > 0),
  provider_message_id      TEXT NOT NULL CHECK (length(provider_message_id) > 0),
  conversation_id          TEXT NOT NULL CHECK (length(conversation_id) > 0),
  sender_id                TEXT NOT NULL DEFAULT '',
  sender_display           TEXT,
  sent_at                  TIMESTAMPTZ NOT NULL,
  direction                TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  kind                     TEXT NOT NULL CHECK (kind IN ('text', 'image', 'voice', 'file', 'link')),
  body_text                TEXT,
  -- Attachment metadata only; bytes stay in the platform local-file backend.
  media_ref                JSONB,
  reply_to_provider_id     TEXT,
  -- Sanitized provider payload retained for explicit reparsing only.
  raw_provider_blob        JSONB,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (instance_id, provider_message_id)
);

CREATE INDEX idx_chat_archive_messages_owner_sent
  ON chat_archive_messages (owner_user_id, sent_at DESC);
CREATE INDEX idx_chat_archive_messages_conversation_sent
  ON chat_archive_messages (instance_id, conversation_id, sent_at, id);
CREATE INDEX idx_chat_archive_messages_reply
  ON chat_archive_messages (instance_id, reply_to_provider_id)
  WHERE reply_to_provider_id IS NOT NULL;

ALTER TABLE chat_archive_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_messages_owner ON chat_archive_messages
  USING (owner_user_id = (current_setting('app.current_user_id'::text, true))::uuid);

CREATE TABLE chat_archive_segments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id               UUID NOT NULL REFERENCES chat_archive_messages(id) ON DELETE CASCADE,
  instance_id              UUID NOT NULL,
  conversation_id          TEXT NOT NULL,
  segment_index            INT NOT NULL DEFAULT 0,
  segment_text             TEXT NOT NULL CHECK (length(segment_text) > 0),

  -- Universal retrieval projection columns, matching email/file/transcript
  -- segments. The person-owner axis is mandatory; assistant scope is absent.
  user_id                  UUID NOT NULL,
  assistant_id             UUID,
  source                   TEXT NOT NULL DEFAULT 'chat_archive',
  sensitivity              TEXT NOT NULL DEFAULT 'internal',
  compartments             TEXT[] NOT NULL DEFAULT '{}',
  tags                     TEXT[],
  metadata                 JSONB,
  verified_by_user_id      UUID,
  verified_at              TIMESTAMPTZ,
  valid_from               TIMESTAMPTZ NOT NULL,
  valid_to                 TIMESTAMPTZ,
  superseded_by            UUID,
  retracted_at             TIMESTAMPTZ,
  retracted_by_user_id     UUID,
  retracted_reason         TEXT,
  created_by_user_id       UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Standard six-column embedding scaffold.
  embedding                VECTOR(768),
  embedding_model_id       TEXT,
  content_hash             TEXT,
  embedding_failed_at      TIMESTAMPTZ,
  embedding_failure_reason TEXT,
  embedding_updated_at     TIMESTAMPTZ,

  UNIQUE (message_id, segment_index)
);

CREATE INDEX idx_chat_archive_segments_instance_conversation
  ON chat_archive_segments (instance_id, conversation_id, valid_from);
CREATE INDEX idx_chat_archive_segments_embedding
  ON chat_archive_segments
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_chat_archive_segments_trgm
  ON chat_archive_segments USING gin (segment_text gin_trgm_ops);
CREATE INDEX idx_chat_archive_segments_embed_queue_valid_from
  ON chat_archive_segments (valid_from)
  WHERE embedding IS NULL AND embedding_failed_at IS NULL;

ALTER TABLE chat_archive_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_segments_owner ON chat_archive_segments
  USING (user_id = (current_setting('app.current_user_id'::text, true))::uuid);

-- Evidence-backed acquisition windows. Ordinary silence is not a gap; the
-- writer extends/merges a window for forward delivery and leaves disjoint
-- windows only for independently acquired history ranges.
CREATE TABLE chat_archive_coverage_windows (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id               UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id             UUID NOT NULL,
  conversation_id           TEXT NOT NULL CHECK (length(conversation_id) > 0),
  window_start              TIMESTAMPTZ NOT NULL,
  window_end                TIMESTAMPTZ NOT NULL,
  first_provider_message_id TEXT NOT NULL,
  last_provider_message_id  TEXT NOT NULL,
  source_cursor             JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (window_start <= window_end),
  UNIQUE (instance_id, conversation_id, window_start, window_end)
);

CREATE INDEX idx_chat_archive_coverage_lookup
  ON chat_archive_coverage_windows (instance_id, conversation_id, window_start);

ALTER TABLE chat_archive_coverage_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_coverage_windows_owner ON chat_archive_coverage_windows
  USING (owner_user_id = (current_setting('app.current_user_id'::text, true))::uuid);

-- Resumable offline import ledger. The input fingerprint identifies an export
-- or decrypted database without storing its local path in the shared brain.
CREATE TABLE chat_archive_backfill_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id           UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id         UUID NOT NULL,
  source                TEXT NOT NULL CHECK (length(source) > 0),
  input_kind            TEXT NOT NULL CHECK (length(input_kind) > 0),
  input_fingerprint     TEXT NOT NULL CHECK (length(input_fingerprint) > 0),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  checkpoint            JSONB,
  discovered_count      BIGINT NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  accepted_count        BIGINT NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  duplicate_count       BIGINT NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  rejected_count        BIGINT NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  last_error            TEXT,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (instance_id, source, input_kind, input_fingerprint)
);

CREATE INDEX idx_chat_archive_backfill_runs_owner_created
  ON chat_archive_backfill_runs (owner_user_id, created_at DESC);

ALTER TABLE chat_archive_backfill_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_backfill_runs_owner ON chat_archive_backfill_runs
  USING (owner_user_id = (current_setting('app.current_user_id'::text, true))::uuid);

COMMIT;
