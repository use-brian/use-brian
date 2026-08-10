-- 433_gdrive_metadata_catalog.sql
--
-- Workspace-specific BYO Drive indexing scope plus the cheap metadata catalog
-- that backs selected-folder read confinement and asynchronous descriptor
-- embeddings. Content enrichment remains in gdrive_file_enrichments.

BEGIN;

CREATE TABLE gdrive_catalog_syncs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_instance_id UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  acting_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sync_scope            TEXT NOT NULL CHECK (sync_scope IN ('entire_drive', 'selected_folders')),
  selected_folders      JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation            UUID NOT NULL DEFAULT gen_random_uuid(),
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  estimated_files       INTEGER CHECK (estimated_files IS NULL OR estimated_files >= 0),
  files_seen            INTEGER NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  files_indexed         INTEGER NOT NULL DEFAULT 0 CHECK (files_indexed >= 0),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error            TEXT,
  locked_at             TIMESTAMPTZ,
  next_sync_at          TIMESTAMPTZ,
  last_completed_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gdrive_catalog_syncs_scope_folders CHECK (
    jsonb_typeof(selected_folders) = 'array'
    AND (
      (sync_scope = 'entire_drive' AND jsonb_array_length(selected_folders) = 0)
      OR
      (sync_scope = 'selected_folders'
       AND jsonb_array_length(selected_folders) BETWEEN 1 AND 50)
    )
  ),
  UNIQUE (workspace_id, connector_instance_id)
);

CREATE INDEX idx_gdrive_catalog_syncs_claim
  ON gdrive_catalog_syncs (status, next_sync_at, updated_at);

CREATE TABLE gdrive_file_catalog (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_instance_id UUID NOT NULL REFERENCES connector_instance(id) ON DELETE CASCADE,
  external_file_id      TEXT NOT NULL,
  name                  TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  source_version        TEXT NOT NULL,
  modified_time         TIMESTAMPTZ,
  size_bytes            BIGINT,
  web_view_link         TEXT,
  parent_ids            TEXT[] NOT NULL DEFAULT '{}',
  folder_path           TEXT[] NOT NULL DEFAULT '{}',
  is_folder             BOOLEAN NOT NULL DEFAULT false,
  active                BOOLEAN NOT NULL DEFAULT false,
  artifact_file_id      UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  last_seen_generation  UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gdrive_file_catalog_external_id_nonempty CHECK (length(external_file_id) BETWEEN 1 AND 1024),
  CONSTRAINT gdrive_file_catalog_name_nonempty CHECK (length(name) BETWEEN 1 AND 1024),
  CONSTRAINT gdrive_file_catalog_mime_nonempty CHECK (length(mime_type) BETWEEN 1 AND 512),
  CONSTRAINT gdrive_file_catalog_version_nonempty CHECK (length(source_version) BETWEEN 1 AND 256),
  UNIQUE (workspace_id, connector_instance_id, external_file_id)
);

CREATE INDEX idx_gdrive_file_catalog_membership
  ON gdrive_file_catalog (workspace_id, connector_instance_id, external_file_id);

CREATE INDEX idx_gdrive_file_catalog_name
  ON gdrive_file_catalog (workspace_id, connector_instance_id, lower(name));

CREATE INDEX idx_gdrive_file_catalog_parents
  ON gdrive_file_catalog USING gin (parent_ids);

ALTER TABLE gdrive_catalog_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gdrive_file_catalog ENABLE ROW LEVEL SECURITY;

COMMIT;
