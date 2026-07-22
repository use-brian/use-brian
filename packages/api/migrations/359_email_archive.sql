-- 359_email_archive.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Email archive corpus for the Company Email (IMAP) connector — the third
-- "source corpus beside the brain" (recordings/transcript_segments and
-- files/file_segments are the precedents). Full-mailbox sync lands every
-- message here (D5 — never as brain episodes); segments are embedded async
-- and searched via the dedicated searchEmailArchive tool (NOT in
-- KNOWN_SCOPES, so it never floods general searchBrain).
--
-- Person-compartmented from day one (D7): a mailbox is personal even inside
-- a shared workspace. Message rows RLS-gate on the OWNER; segment rows stamp
-- user_id = owner / assistant_id = NULL so the retrieval visibility double
-- hides them from every other member's searches.
--
-- Provider-agnostic identity (D13): messages key on
-- (instance_id, provider_message_id) — IMAP uses "<folder>:<uid>"; a future
-- Gmail/Graph provider uses its native id — with the RFC Message-ID kept for
-- cross-provider threading/dedupe. Sync state lives as an opaque per-provider
-- cursor on connector_instance.config, never as columns here.
--
-- See docs/architecture/integrations/mailbox-imap.md.

BEGIN;

CREATE TABLE email_archive_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id),
  instance_id         UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id       UUID NOT NULL,
  folder              TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  rfc_message_id      TEXT,
  subject             TEXT NOT NULL DEFAULT '',
  from_addr           TEXT NOT NULL DEFAULT '',
  to_addrs            TEXT[] NOT NULL DEFAULT '{}',
  cc_addrs            TEXT[] NOT NULL DEFAULT '{}',
  sent_at             TIMESTAMPTZ,
  body_text           TEXT NOT NULL DEFAULT '',
  in_reply_to         TEXT,
  references_ids      TEXT[] NOT NULL DEFAULT '{}',
  -- Attachment METADATA only (filename/mime/size) — content extraction is a
  -- later confirmed opt-in (D10).
  has_attachments     BOOLEAN NOT NULL DEFAULT false,
  attachments         JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (instance_id, provider_message_id)
);

CREATE INDEX idx_email_archive_messages_instance_folder
  ON email_archive_messages (instance_id, folder);
CREATE INDEX idx_email_archive_messages_sent_at
  ON email_archive_messages (instance_id, sent_at DESC);
CREATE INDEX idx_email_archive_messages_rfc_id
  ON email_archive_messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

-- Owner-scoped RLS: a mailbox is a PERSON'S, not the workspace's. Stricter
-- than the workspace-member policy the shared corpora use. NULL-safe two-arg
-- current_setting is load-bearing (system pool has no GUC).
ALTER TABLE email_archive_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_archive_messages_owner ON email_archive_messages
  USING (owner_user_id = (current_setting('app.current_user_id'::text, true))::uuid);

CREATE TABLE email_archive_segments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id),
  message_id         UUID NOT NULL REFERENCES email_archive_messages(id) ON DELETE CASCADE,
  instance_id        UUID NOT NULL,
  segment_index      INT  NOT NULL,
  segment_text       TEXT NOT NULL CHECK (length(segment_text) > 0),

  -- universal columns (visibility double + sensitivity + trust + bi-temporal),
  -- copied verbatim from kb_chunks/transcript_segments so the shared vector
  -- projection's columns EXIST. user_id is ALWAYS the mailbox owner (the
  -- person compartment); assistant_id stays NULL.
  user_id            UUID,
  assistant_id       UUID,
  source             TEXT NOT NULL DEFAULT 'email_archive',
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

  -- Person compartment: the owner axis must always be present (stricter than
  -- the generic visibility double).
  CONSTRAINT email_archive_segments_owner_check CHECK (user_id IS NOT NULL),

  -- embedding scaffold (six-column set, identical to every embedded primitive)
  embedding                VECTOR(768),
  embedding_model_id       TEXT,
  content_hash             TEXT,
  embedding_failed_at      TIMESTAMPTZ,
  embedding_failure_reason TEXT,
  embedding_updated_at     TIMESTAMPTZ,

  UNIQUE (message_id, segment_index)
);

CREATE INDEX idx_email_archive_segments_instance ON email_archive_segments (instance_id);
CREATE INDEX idx_email_archive_segments_embedding ON email_archive_segments
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
-- ILIKE arm (the 336_transcript_segments_trgm precedent).
CREATE INDEX idx_email_archive_segments_trgm ON email_archive_segments
  USING gin (segment_text gin_trgm_ops);

ALTER TABLE email_archive_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_archive_segments_owner ON email_archive_segments
  USING (user_id = (current_setting('app.current_user_id'::text, true))::uuid);

COMMIT;
