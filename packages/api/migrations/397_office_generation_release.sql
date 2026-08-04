-- Durable Office generation/release/offline ledgers. See
-- docs/architecture/features/office.md.

BEGIN;

CREATE TABLE office_generation_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  initiated_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assistant_id          UUID REFERENCES assistants(id) ON DELETE SET NULL,
  job_kind              TEXT NOT NULL DEFAULT 'create' CHECK (job_kind IN ('create','revise','import','export','template_compile','derivative')),
  status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','needs_input','completed','failed','cancelled')),
  stage                 TEXT NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','template','grounding','claim_plan','construct','media','fit_render','validate','export_reparse','completed','needs_input','failed','cancelled')),
  brief                 JSONB NOT NULL,
  authority_projection  JSONB NOT NULL,
  template_version_id   UUID REFERENCES office_template_versions(id) ON DELETE RESTRICT,
  base_artifact_version BIGINT NOT NULL DEFAULT 0 CHECK (base_artifact_version >= 0),
  idempotency_key       TEXT NOT NULL,
  checkpoint            JSONB NOT NULL DEFAULT '{}',
  checkpoint_version    INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token           UUID,
  lease_expires_at      TIMESTAMPTZ,
  cancel_requested_at   TIMESTAMPTZ,
  error_code            TEXT,
  error_detail          TEXT,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, initiated_by_user_id, idempotency_key)
);

CREATE TABLE office_generation_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES office_generation_jobs(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq                   BIGINT NOT NULL CHECK (seq > 0),
  code                  TEXT NOT NULL,
  params                JSONB NOT NULL DEFAULT '{}',
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('user','assistant','system')),
  actor_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_assistant_id    UUID REFERENCES assistants(id) ON DELETE SET NULL,
  safe_narration        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq)
);

CREATE TABLE office_generation_steering (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES office_generation_jobs(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  instruction           TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 10000),
  status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','applied','needs_clarification','superseded','rejected')),
  status_reason         TEXT,
  first_checkpoint_version INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at            TIMESTAMPTZ
);

CREATE TABLE office_claims (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id             UUID NOT NULL,
  range_anchor          JSONB,
  claim_text            TEXT NOT NULL,
  classification        TEXT NOT NULL CHECK (classification IN ('evidence_supported','user_attested','derived','creative_proposed','unsupported_conflicted')),
  confidence            REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  severity              TEXT NOT NULL CHECK (severity IN ('info','warning','high')),
  reason_code           TEXT NOT NULL,
  evidence              JSONB NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','acknowledged','superseded')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_media_uses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id             UUID NOT NULL,
  resource_id           UUID NOT NULL REFERENCES office_resources(id) ON DELETE RESTRICT,
  source_page_url       TEXT,
  direct_asset_url      TEXT,
  publisher             TEXT,
  creator               TEXT,
  licence               JSONB NOT NULL DEFAULT '{}',
  evidence_snapshot     JSONB NOT NULL DEFAULT '{}',
  provenance_state      TEXT NOT NULL CHECK (provenance_state IN ('verified_reusable','attribution_required','commercial_or_permission_required','rights_unverified','source_unavailable')),
  transformation        JSONB NOT NULL DEFAULT '{}',
  disclosure_required   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_release_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE RESTRICT,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action                TEXT NOT NULL CHECK (action IN ('export','share','present','send','publish','derivative')),
  destination_projection JSONB NOT NULL,
  validation_receipt    JSONB NOT NULL,
  acknowledgement       JSONB,
  released_file_id      UUID REFERENCES workspace_files(id) ON DELETE SET NULL,
  released_by           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE office_offline_packages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  artifact_version_id   UUID NOT NULL REFERENCES office_artifact_versions(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id             TEXT NOT NULL,
  package_file_id       UUID NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  manifest              JSONB NOT NULL,
  manifest_hash         TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  signature             TEXT NOT NULL,
  state_vector          BYTEA NOT NULL,
  complete              BOOLEAN NOT NULL DEFAULT FALSE,
  pinned                BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at            TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, user_id, device_id)
);

CREATE INDEX idx_office_generation_claim
  ON office_generation_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued','running') AND cancel_requested_at IS NULL;
CREATE INDEX idx_office_generation_lease
  ON office_generation_jobs (lease_expires_at) WHERE lease_token IS NOT NULL;
CREATE INDEX idx_office_generation_artifact
  ON office_generation_jobs (artifact_id, created_at DESC);
CREATE INDEX idx_office_generation_events_job
  ON office_generation_events (job_id, seq);
CREATE INDEX idx_office_generation_steering_queue
  ON office_generation_steering (job_id, created_at) WHERE status = 'queued';
CREATE INDEX idx_office_claims_review
  ON office_claims (artifact_id, status, severity, created_at);
CREATE INDEX idx_office_media_release
  ON office_media_uses (artifact_id, provenance_state, disclosure_required);
CREATE INDEX idx_office_offline_expiry
  ON office_offline_packages (expires_at) WHERE pinned = FALSE AND revoked_at IS NULL;

ALTER TABLE office_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_generation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_generation_steering ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_media_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_release_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_offline_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_generation_jobs_member ON office_generation_jobs USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_generation_events_member ON office_generation_events USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_generation_steering_member ON office_generation_steering USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_claims_member ON office_claims USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_media_uses_member ON office_media_uses USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_release_records_member ON office_release_records USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY office_offline_packages_owner ON office_offline_packages USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
