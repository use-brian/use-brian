-- 409_chat_archive_media.sql (OPEN tables -> packages/api/migrations/)
-- Durable local media for the provider-neutral chat archive.

BEGIN;

ALTER TABLE chat_archive_messages
  DROP CONSTRAINT chat_archive_messages_kind_check;
ALTER TABLE chat_archive_messages
  ADD CONSTRAINT chat_archive_messages_kind_check
  CHECK (kind IN ('text', 'image', 'video', 'voice', 'file', 'link'));

ALTER TABLE chat_archive_backfill_runs
  ADD COLUMN media_discovered_count BIGINT NOT NULL DEFAULT 0 CHECK (media_discovered_count >= 0),
  ADD COLUMN media_stored_count BIGINT NOT NULL DEFAULT 0 CHECK (media_stored_count >= 0),
  ADD COLUMN media_missing_count BIGINT NOT NULL DEFAULT 0 CHECK (media_missing_count >= 0),
  ADD COLUMN media_failed_count BIGINT NOT NULL DEFAULT 0 CHECK (media_failed_count >= 0);

CREATE TABLE chat_archive_media_assets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instance_id              UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  owner_user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id               UUID REFERENCES chat_archive_messages(id) ON DELETE CASCADE,
  source                   TEXT NOT NULL CHECK (length(source) > 0),
  provider_message_id      TEXT NOT NULL CHECK (length(provider_message_id) > 0),
  kind                     TEXT NOT NULL CHECK (kind IN ('image', 'video', 'voice', 'file')),
  filename                 TEXT NOT NULL DEFAULT '',
  mime                     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes               BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  expected_sha256          TEXT CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  sha256                   TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  storage_key              TEXT NOT NULL CHECK (length(storage_key) > 0),
  storage_uri              TEXT NOT NULL CHECK (length(storage_uri) > 0),
  upload_status            TEXT NOT NULL DEFAULT 'uploading'
                           CHECK (upload_status IN ('uploading', 'uploaded', 'stored', 'failed')),
  extraction_status        TEXT NOT NULL DEFAULT 'pending'
                           CHECK (extraction_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  last_error               TEXT,
  linked_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (instance_id, provider_message_id)
);

CREATE INDEX idx_chat_archive_media_assets_message
  ON chat_archive_media_assets (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_chat_archive_media_assets_owner_created
  ON chat_archive_media_assets (owner_user_id, created_at DESC);
CREATE INDEX idx_chat_archive_media_assets_unlinked_cleanup
  ON chat_archive_media_assets (created_at)
  WHERE message_id IS NULL;

ALTER TABLE chat_archive_media_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_media_assets_owner ON chat_archive_media_assets
  USING (owner_user_id = (current_setting('app.current_user_id'::text, true))::uuid);

CREATE TABLE chat_archive_media_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id            UUID NOT NULL UNIQUE REFERENCES chat_archive_media_assets(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead', 'unsupported')),
  attempt_count       INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until        TIMESTAMPTZ,
  last_error          TEXT,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_archive_media_jobs_due
  ON chat_archive_media_jobs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE chat_archive_media_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_media_jobs_system ON chat_archive_media_jobs
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

-- Filesystem deletion cannot happen inside a database cascade. Queue the
-- storage location before the asset row disappears; the local media worker
-- drains this table idempotently.
CREATE TABLE chat_archive_media_deletions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL,
  storage_key     TEXT NOT NULL,
  storage_uri     TEXT NOT NULL,
  attempt_count   INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (storage_uri, storage_key)
);

CREATE INDEX idx_chat_archive_media_deletions_due
  ON chat_archive_media_deletions (next_attempt_at, created_at);

ALTER TABLE chat_archive_media_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_archive_media_deletions_system ON chat_archive_media_deletions
  USING (current_setting('app.system_bypass', true) = 'true')
  WITH CHECK (current_setting('app.system_bypass', true) = 'true');

CREATE FUNCTION queue_chat_archive_media_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO chat_archive_media_deletions (workspace_id, storage_key, storage_uri)
  VALUES (OLD.workspace_id, OLD.storage_key, OLD.storage_uri)
  ON CONFLICT (storage_uri, storage_key) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER chat_archive_media_assets_queue_delete
BEFORE DELETE ON chat_archive_media_assets
FOR EACH ROW EXECUTE FUNCTION queue_chat_archive_media_deletion();

COMMIT;
