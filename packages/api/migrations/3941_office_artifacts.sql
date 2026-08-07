-- Canonical Office artifacts, immutable checkpoints, source projections,
-- collaboration grants, and the audit spine. See
-- docs/architecture/features/office.md. This migration is created and tested
-- locally by the Office build; production execution is a rollout owed item.

BEGIN;

CREATE TABLE office_artifacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family                TEXT NOT NULL CHECK (family IN ('document','presentation')),
  mode                  TEXT NOT NULL DEFAULT 'artifact' CHECK (mode IN ('artifact','template')),
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  creator_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_version_id   UUID,
  head_version_id       UUID,
  head_version          BIGINT NOT NULL DEFAULT 0 CHECK (head_version >= 0),
  capability_version    INTEGER NOT NULL CHECK (capability_version > 0),
  sensitivity           TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential')),
  visibility_user_ids   UUID[] NOT NULL DEFAULT '{}',
  visibility_assistant_ids UUID[] NOT NULL DEFAULT '{}',
  required_compartments TEXT[] NOT NULL DEFAULT '{}',
  default_workspace_role TEXT NOT NULL DEFAULT 'comment'
                           CHECK (default_workspace_role IN ('view','comment','edit')),
  lifecycle_state       TEXT NOT NULL DEFAULT 'active'
                           CHECK (lifecycle_state IN ('active','archived','trash','retained','purged')),
  archived_at           TIMESTAMPTZ,
  trashed_at            TIMESTAMPTZ,
  retain_at             TIMESTAMPTZ,
  purge_at              TIMESTAMPTZ,
  legal_hold            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lifecycle_state <> 'trash') OR trashed_at IS NOT NULL),
  CHECK ((lifecycle_state <> 'retained') OR retain_at IS NOT NULL)
);

CREATE TABLE office_artifact_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version               BIGINT NOT NULL CHECK (version >= 0),
  parent_version_id     UUID REFERENCES office_artifact_versions(id) ON DELETE SET NULL,
  snapshot_file_id      UUID NOT NULL REFERENCES workspace_files(id) ON DELETE RESTRICT,
  snapshot_hash         TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  operation_clock       BYTEA NOT NULL,
  schema_version        INTEGER NOT NULL CHECK (schema_version > 0),
  capability_version    INTEGER NOT NULL CHECK (capability_version > 0),
  author_type           TEXT NOT NULL CHECK (author_type IN ('user','assistant','import','system')),
  author_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  author_assistant_id   UUID REFERENCES assistants(id) ON DELETE SET NULL,
  origin                TEXT NOT NULL CHECK (origin IN ('manual','ai','import','offline','restore','generation')),
  summary               TEXT NOT NULL DEFAULT '',
  named                 BOOLEAN NOT NULL DEFAULT FALSE,
  checkpoint_kind       TEXT CHECK (checkpoint_kind IN ('named','export','release','generation','revision','restore','template_migration')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version),
  UNIQUE (artifact_id, snapshot_hash, version)
);

ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_head_version_fk
  FOREIGN KEY (head_version_id) REFERENCES office_artifact_versions(id) ON DELETE SET NULL;

CREATE TABLE office_artifact_sources (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('brain','website','user_attested','upload','artifact','media')),
  source_id             TEXT NOT NULL,
  source_version        TEXT,
  source_hash           TEXT CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
  sensitivity           TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential','restricted')),
  visibility_user_ids   UUID[] NOT NULL DEFAULT '{}',
  visibility_assistant_ids UUID[] NOT NULL DEFAULT '{}',
  required_compartments TEXT[] NOT NULL DEFAULT '{}',
  retracted_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_version_id, source_kind, source_id, source_version)
);

CREATE TABLE office_artifact_grants (
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL CHECK (role IN ('view','comment','edit','deny')),
  granted_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  elevation_reason      TEXT,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,
  PRIMARY KEY (artifact_id, user_id)
);

CREATE TABLE office_audit_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id           UUID REFERENCES office_artifacts(id) ON DELETE SET NULL,
  actor_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_assistant_id    UUID REFERENCES assistants(id) ON DELETE SET NULL,
  event_type            TEXT NOT NULL,
  artifact_version      BIGINT,
  reason                TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_artifacts_workspace_lifecycle
  ON office_artifacts (workspace_id, lifecycle_state, updated_at DESC);
CREATE INDEX idx_office_artifacts_retention
  ON office_artifacts (purge_at) WHERE lifecycle_state IN ('trash','retained') AND legal_hold = FALSE;
CREATE INDEX idx_office_versions_artifact_created
  ON office_artifact_versions (artifact_id, created_at DESC);
CREATE INDEX idx_office_sources_source
  ON office_artifact_sources (workspace_id, source_kind, source_id);
CREATE INDEX idx_office_grants_user
  ON office_artifact_grants (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_office_audit_artifact
  ON office_audit_events (artifact_id, created_at DESC);

ALTER TABLE office_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_artifact_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_artifact_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_artifacts_member ON office_artifacts
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_versions_member ON office_artifact_versions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_sources_member ON office_artifact_sources
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_grants_member ON office_artifact_grants
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_audit_member ON office_audit_events
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));

-- Office is reserved in every existing workspace without disturbing the
-- owner's stored order. The app-web registry keeps it non-navigable until the
-- Phase 3 barrier enables the route.
UPDATE workspaces
   SET home_apps = home_apps || '"office"'::jsonb
 WHERE jsonb_typeof(home_apps) = 'array'
   AND NOT home_apps ? 'office';

COMMENT ON COLUMN workspaces.home_apps IS
  'Ordered Home app-bar config, 1-7 built-in/custom entries. [] resolves to the source default [page, office, chat].';

COMMIT;
