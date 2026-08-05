-- 397_chat_archive_enrichment.sql  (OPEN tables -> packages/api/migrations/)
-- Platform-owned Pipeline B window ledger for raw chat archive messages.

BEGIN;

CREATE TABLE chat_archive_enrichment_windows (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id                UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id              UUID NOT NULL,
  conversation_id            TEXT NOT NULL,
  first_message_id           UUID NOT NULL REFERENCES chat_archive_messages(id) ON DELETE CASCADE,
  last_message_id            UUID NOT NULL REFERENCES chat_archive_messages(id) ON DELETE CASCADE,
  first_provider_message_id  TEXT NOT NULL,
  last_provider_message_id   TEXT NOT NULL,
  window_start               TIMESTAMPTZ NOT NULL,
  window_end                 TIMESTAMPTZ NOT NULL,
  message_count              INT NOT NULL CHECK (message_count > 0),
  content_hash               TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  attempt_count              INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until               TIMESTAMPTZ,
  last_error                 TEXT,
  completed_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (window_start <= window_end),
  UNIQUE (instance_id, conversation_id, first_message_id, last_message_id)
);

CREATE INDEX idx_chat_archive_enrichment_due
  ON chat_archive_enrichment_windows (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE chat_archive_enrichment_messages (
  message_id UUID PRIMARY KEY REFERENCES chat_archive_messages(id) ON DELETE CASCADE,
  window_id  UUID NOT NULL REFERENCES chat_archive_enrichment_windows(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_archive_enrichment_messages_window
  ON chat_archive_enrichment_messages (window_id);

ALTER TABLE chat_archive_enrichment_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_enrichment_windows_system ON chat_archive_enrichment_windows
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

ALTER TABLE chat_archive_enrichment_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_enrichment_messages_system ON chat_archive_enrichment_messages
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

COMMIT;
