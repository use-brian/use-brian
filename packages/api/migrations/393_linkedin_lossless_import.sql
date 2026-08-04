-- Lossless LinkedIn archive ingestion.
--
-- The ZIP and each member live in workspace_files. These tables are the
-- deterministic evidence ledger + restartable queue; entities/entity_links are
-- a rebuildable graph projection. See docs/architecture/brain/linkedin-import.md.

BEGIN;

INSERT INTO entity_link_types (edge_type, description)
VALUES (
  'connected_to',
  'person -> person: direct source-attested connection (distinct from mutual_connection)'
)
ON CONFLICT (edge_type) DO NOTHING;

CREATE TABLE linkedin_import_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  acting_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id             UUID REFERENCES assistants(id) ON DELETE SET NULL,
  archive_file_id          UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  archive_name             TEXT NOT NULL,
  archive_sha256           TEXT NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_size_bytes       BIGINT NOT NULL CHECK (archive_size_bytes >= 0),
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','processing','completed','failed')),
  stage                    TEXT NOT NULL DEFAULT 'queued',
  attempts                 INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error               TEXT,
  locked_at                TIMESTAMPTZ,
  lease_token              UUID,
  member_count             INTEGER NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  completed_member_count   INTEGER NOT NULL DEFAULT 0 CHECK (completed_member_count >= 0),
  row_count                INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  mapped_count             INTEGER NOT NULL DEFAULT 0 CHECK (mapped_count >= 0),
  stored_count             INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
  unresolved_count         INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  malformed_count          INTEGER NOT NULL DEFAULT 0 CHECK (malformed_count >= 0),
  entity_count             INTEGER NOT NULL DEFAULT 0 CHECK (entity_count >= 0),
  edge_count               INTEGER NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, acting_user_id, archive_sha256)
);

CREATE INDEX idx_linkedin_import_runs_claim
  ON linkedin_import_runs (created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX idx_linkedin_import_runs_actor
  ON linkedin_import_runs (acting_user_id, created_at DESC);

CREATE TABLE linkedin_import_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES linkedin_import_runs(id) ON DELETE CASCADE,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_path         TEXT NOT NULL CHECK (length(member_path) BETWEEN 1 AND 768),
  content_sha256      TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  compressed_size     BIGINT CHECK (compressed_size IS NULL OR compressed_size >= 0),
  size_bytes          BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime                TEXT NOT NULL,
  file_id             UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  parse_status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (parse_status IN ('pending','completed','failed','stored')),
  header_row_ordinal  INTEGER CHECK (header_row_ordinal IS NULL OR header_row_ordinal >= 1),
  header_cells        JSONB,
  record_count        INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, member_path)
);

CREATE INDEX idx_linkedin_import_members_run ON linkedin_import_members (run_id);

CREATE TABLE linkedin_import_rows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES linkedin_import_runs(id) ON DELETE CASCADE,
  member_id           UUID NOT NULL REFERENCES linkedin_import_members(id) ON DELETE CASCADE,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_path         TEXT NOT NULL,
  row_ordinal         INTEGER NOT NULL CHECK (row_ordinal >= 1),
  data_ordinal        INTEGER CHECK (data_ordinal IS NULL OR data_ordinal >= 1),
  record_kind         TEXT NOT NULL CHECK (record_kind IN ('preamble','header','data','blank')),
  start_line          INTEGER NOT NULL CHECK (start_line >= 1),
  end_line            INTEGER NOT NULL CHECK (end_line >= start_line),
  cells               JSONB NOT NULL CHECK (jsonb_typeof(cells) = 'array'),
  values              JSONB,
  raw_sha256          TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  outcome             TEXT NOT NULL CHECK (outcome IN ('mapped','stored','unresolved','malformed')),
  outcome_reason      TEXT,
  entity_ids          UUID[] NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, member_path, row_ordinal)
);

CREATE INDEX idx_linkedin_import_rows_run_outcome
  ON linkedin_import_rows (run_id, outcome);
CREATE INDEX idx_linkedin_import_rows_member
  ON linkedin_import_rows (member_id, row_ordinal);
CREATE INDEX idx_linkedin_import_rows_values
  ON linkedin_import_rows USING GIN (values jsonb_path_ops);

-- Multiple exact external identifiers can point at one canonical entity. The
-- user partition is load-bearing: LinkedIn archives are confidential and two
-- members of one workspace must not resolve through one another's private data.
CREATE TABLE entity_external_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  identity_kind       TEXT NOT NULL,
  normalized_value    TEXT NOT NULL,
  original_value      TEXT NOT NULL,
  entity_id           UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  attributes          JSONB NOT NULL DEFAULT '{}',
  first_seen_run_id   UUID REFERENCES linkedin_import_runs(id) ON DELETE SET NULL,
  last_seen_run_id    UUID REFERENCES linkedin_import_runs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, provider, identity_kind, normalized_value)
);

CREATE INDEX idx_entity_external_identities_entity
  ON entity_external_identities (entity_id);
CREATE INDEX idx_entity_external_identities_lookup
  ON entity_external_identities (workspace_id, user_id, provider, identity_kind, normalized_value);

ALTER TABLE linkedin_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_import_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_external_identities ENABLE ROW LEVEL SECURITY;

-- Run/member/row tables are queue-owned. Authenticated HTTP reads are explicit,
-- membership-checked system-store methods; app-role SQL has no direct policy.
CREATE POLICY entity_external_identities_owner
  ON entity_external_identities
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
