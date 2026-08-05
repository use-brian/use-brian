-- Declarative Office template registry and immutable workspace resources.
-- Executable extensions have no table/type and therefore cannot be installed.

BEGIN;

CREATE TABLE office_templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family                TEXT NOT NULL CHECK (family IN ('document','presentation')),
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description           TEXT NOT NULL DEFAULT '',
  owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  current_version_id    UUID,
  default_use_case      TEXT,
  lifecycle_state       TEXT NOT NULL DEFAULT 'draft'
                           CHECK (lifecycle_state IN ('draft','admitted','deprecated','trash','retained','purged')),
  replacement_template_id UUID REFERENCES office_templates(id) ON DELETE SET NULL,
  sensitivity           TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential')),
  visibility_user_ids   UUID[] NOT NULL DEFAULT '{}',
  trashed_at            TIMESTAMPTZ,
  retain_at             TIMESTAMPTZ,
  purge_at              TIMESTAMPTZ,
  legal_hold            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_template_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id           UUID NOT NULL REFERENCES office_templates(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL CHECK (version > 0),
  parent_version_id     UUID REFERENCES office_template_versions(id) ON DELETE SET NULL,
  source_artifact_version_id UUID REFERENCES office_artifact_versions(id) ON DELETE RESTRICT,
  bundle_file_id        UUID NOT NULL REFERENCES workspace_files(id) ON DELETE RESTRICT,
  bundle_hash           TEXT NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
  capability_version    INTEGER NOT NULL CHECK (capability_version > 0),
  locales               TEXT[] NOT NULL,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  when_to_use           JSONB NOT NULL CHECK (jsonb_typeof(when_to_use) = 'array'),
  when_not_to_use       JSONB NOT NULL CHECK (jsonb_typeof(when_not_to_use) = 'array'),
  example_requests      JSONB NOT NULL CHECK (jsonb_typeof(example_requests) = 'array'),
  field_schema          JSONB NOT NULL,
  selection_metadata    JSONB NOT NULL DEFAULT '{}',
  admission_receipt     JSONB NOT NULL,
  provenance            JSONB NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('draft','admitted','deprecated','trash')),
  admitted_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  admitted_at           TIMESTAMPTZ,
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  UNIQUE (workspace_id, bundle_hash)
);

ALTER TABLE office_templates
  ADD CONSTRAINT office_templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES office_template_versions(id) ON DELETE SET NULL;

ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_template_version_fk
  FOREIGN KEY (template_version_id) REFERENCES office_template_versions(id) ON DELETE RESTRICT;

CREATE TABLE office_resources (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('font','theme','field_schema','brand_media','reusable_section','reusable_slide')),
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  file_id               UUID REFERENCES workspace_files(id) ON DELETE RESTRICT,
  content_hash          TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  mime                  TEXT NOT NULL,
  licence               JSONB NOT NULL DEFAULT '{}',
  embedding_rights      TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (embedding_rights IN ('allowed','subset_only','prohibited','unknown')),
  provenance            JSONB NOT NULL DEFAULT '{}',
  sensitivity           TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','trash','retained')),
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, content_hash)
);

CREATE TABLE office_template_resource_refs (
  template_version_id   UUID NOT NULL REFERENCES office_template_versions(id) ON DELETE CASCADE,
  resource_id           UUID NOT NULL REFERENCES office_resources(id) ON DELETE RESTRICT,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage                 TEXT NOT NULL,
  required              BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (template_version_id, resource_id, usage)
);

CREATE INDEX idx_office_templates_workspace_status ON office_templates (workspace_id, family, lifecycle_state, updated_at DESC);
CREATE INDEX idx_office_template_versions_selection ON office_template_versions (workspace_id, status, created_at DESC);
CREATE INDEX idx_office_template_versions_tags ON office_template_versions USING GIN (tags);
CREATE INDEX idx_office_resources_workspace_kind ON office_resources (workspace_id, kind, status);
CREATE INDEX idx_office_templates_retention ON office_templates (purge_at) WHERE lifecycle_state IN ('trash','retained') AND legal_hold = FALSE;

ALTER TABLE office_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_template_resource_refs ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_templates_member ON office_templates
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_template_versions_member ON office_template_versions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_resources_member ON office_resources
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_template_resource_refs_member ON office_template_resource_refs
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));

COMMIT;
