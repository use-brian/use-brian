-- 432_gdrive_file_enrichment.sql
--
-- Version-idempotent Google Drive enrichment ledger + worker queue. Full-Drive
-- reads enqueue metadata only; the worker re-opens the exact connector instance
-- and stores/indexes the current version. Premium offline bundles enter the
-- same queue with a pre-filled payload and bypass model decomposition.

BEGIN;

CREATE TABLE gdrive_file_enrichments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_instance_id UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  acting_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id          UUID REFERENCES assistants(id) ON DELETE SET NULL,
  external_file_id      TEXT NOT NULL,
  source_version        TEXT NOT NULL,
  file_name             TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  modified_time         TIMESTAMPTZ,
  web_view_link         TEXT,
  mode                  TEXT NOT NULL CHECK (mode IN ('lazy_fetch', 'offline_bundle')),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'done', 'failed', 'superseded')),
  prefilled_payload     JSONB,
  artifact_file_id      UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  source_episode_id     UUID REFERENCES episodes(id) ON DELETE SET NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  locked_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gdrive_file_enrichments_external_id_nonempty CHECK (length(external_file_id) BETWEEN 1 AND 1024),
  CONSTRAINT gdrive_file_enrichments_version_nonempty CHECK (length(source_version) BETWEEN 1 AND 256),
  CONSTRAINT gdrive_file_enrichments_name_nonempty CHECK (length(file_name) BETWEEN 1 AND 1024),
  CONSTRAINT gdrive_file_enrichments_mime_nonempty CHECK (length(mime_type) BETWEEN 1 AND 512),
  CONSTRAINT gdrive_file_enrichments_payload_mode CHECK (
    (mode = 'offline_bundle' AND (
      prefilled_payload IS NOT NULL OR status IN ('done', 'superseded')
    ))
    OR mode = 'lazy_fetch'
  )
);

CREATE UNIQUE INDEX idx_gdrive_file_enrichments_version
  ON gdrive_file_enrichments (workspace_id, connector_instance_id, external_file_id, source_version);

CREATE INDEX idx_gdrive_file_enrichments_claim
  ON gdrive_file_enrichments (created_at)
  WHERE status = 'pending';

CREATE INDEX idx_gdrive_file_enrichments_status
  ON gdrive_file_enrichments (workspace_id, connector_instance_id, status);

ALTER TABLE gdrive_file_enrichments ENABLE ROW LEVEL SECURITY;

COMMIT;
