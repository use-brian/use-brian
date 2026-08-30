-- Agent-native CRM operations: typed intake, compliance evidence, shared
-- segments, generic participation, domain-event outbox, and resumable imports.
-- Spec: docs/architecture/features/crm-operations.md

BEGIN;

CREATE TABLE crm_intake_definitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_key     TEXT NOT NULL CHECK (definition_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  label              TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  active             BOOLEAN NOT NULL DEFAULT true,
  current_version    INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, definition_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE crm_intake_definition_versions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id             UUID NOT NULL,
  version                   INTEGER NOT NULL CHECK (version > 0),
  field_catalog             JSONB NOT NULL CHECK (jsonb_typeof(field_catalog) = 'array'
                                AND pg_column_size(field_catalog) <= 65536),
  identity_policy           TEXT NOT NULL CHECK (identity_policy IN
                                ('external_subject','trusted_verified_email','new_or_review')),
  allowed_identity_provider TEXT CHECK (allowed_identity_provider IS NULL OR
                                allowed_identity_provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  consent_mappings          JSONB NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(consent_mappings) = 'array'
                                  AND pg_column_size(consent_mappings) <= 32768),
  queue_key                 TEXT NOT NULL DEFAULT 'general'
                                CHECK (queue_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  owner_user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  follow_up_task_template   JSONB CHECK (follow_up_task_template IS NULL OR
                                (jsonb_typeof(follow_up_task_template) = 'object'
                                  AND pg_column_size(follow_up_task_template) <= 16384)),
  follow_up_due_minutes     INTEGER CHECK (follow_up_due_minutes IS NULL OR
                                follow_up_due_minutes BETWEEN 0 AND 525600),
  max_payload_bytes         INTEGER NOT NULL DEFAULT 65536
                                CHECK (max_payload_bytes BETWEEN 1024 AND 1048576),
  workflow_hint             TEXT CHECK (workflow_hint IS NULL OR length(workflow_hint) <= 500),
  schema_hash               TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  schema_snapshot           JSONB NOT NULL CHECK (jsonb_typeof(schema_snapshot) = 'object'
                                AND pg_column_size(schema_snapshot) <= 131072),
  created_by_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, definition_id)
    REFERENCES crm_intake_definitions(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_intake_versions_definition
  ON crm_intake_definition_versions(workspace_id, definition_id, version DESC);

CREATE TABLE crm_intake_credentials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label              TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  secret_prefix      TEXT NOT NULL CHECK (secret_prefix ~ '^sk_intake_[A-Za-z0-9_-]+$'),
  secret_hash        TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at         TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (secret_prefix)
);
CREATE INDEX crm_intake_credentials_live
  ON crm_intake_credentials(workspace_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE crm_intake_credential_definitions (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id UUID NOT NULL,
  definition_id UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, definition_id),
  FOREIGN KEY (workspace_id, credential_id)
    REFERENCES crm_intake_credentials(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, definition_id)
    REFERENCES crm_intake_definitions(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_intake_credential_definitions_workspace
  ON crm_intake_credential_definitions(workspace_id, definition_id, credential_id);

ALTER TABLE association_enquiries
  ADD COLUMN definition_id UUID,
  ADD COLUMN definition_version_id UUID,
  ADD COLUMN follow_up_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN definition_schema_hash TEXT,
  ADD COLUMN definition_schema_snapshot JSONB;
ALTER TABLE association_enquiries
  ADD CONSTRAINT association_enquiries_definition_fk
    FOREIGN KEY (workspace_id, definition_id)
    REFERENCES crm_intake_definitions(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT association_enquiries_definition_version_fk
    FOREIGN KEY (workspace_id, definition_version_id)
    REFERENCES crm_intake_definition_versions(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT association_enquiries_definition_schema_hash_check
    CHECK (definition_schema_hash IS NULL OR definition_schema_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT association_enquiries_definition_schema_snapshot_check
    CHECK (definition_schema_snapshot IS NULL OR
      (jsonb_typeof(definition_schema_snapshot) = 'object'
        AND pg_column_size(definition_schema_snapshot) <= 131072));
CREATE INDEX association_enquiries_definition_queue
  ON association_enquiries(workspace_id, definition_id, status, submitted_at DESC, id DESC);

CREATE TABLE crm_intake_idempotency (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id         UUID,
  actor_scope           TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 250),
  definition_id         UUID NOT NULL,
  idempotency_key       TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash          TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed')),
  submission_id         UUID,
  contact_id            UUID,
  follow_up_task_id     UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at          TIMESTAMPTZ,
  UNIQUE (workspace_id, actor_scope, definition_id, idempotency_key),
  FOREIGN KEY (workspace_id, credential_id)
    REFERENCES crm_intake_credentials(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, definition_id)
    REFERENCES crm_intake_definitions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, submission_id)
    REFERENCES association_enquiries(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (follow_up_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  CHECK ((status = 'pending' AND submission_id IS NULL AND contact_id IS NULL AND committed_at IS NULL)
    OR (status = 'committed' AND submission_id IS NOT NULL AND contact_id IS NOT NULL
      AND committed_at IS NOT NULL))
);
CREATE INDEX crm_intake_idempotency_retention
  ON crm_intake_idempotency(workspace_id, created_at, id);

CREATE TABLE crm_consent_purposes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose_key            TEXT NOT NULL CHECK (purpose_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  label                  TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  description            TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  requires_consent       BOOLEAN NOT NULL DEFAULT true,
  applicable_channels    TEXT[] NOT NULL DEFAULT '{}',
  active_wording_version TEXT NOT NULL CHECK (length(active_wording_version) BETWEEN 1 AND 100),
  wording_snapshot       TEXT NOT NULL CHECK (length(wording_snapshot) BETWEEN 1 AND 20000),
  wording_hash           TEXT NOT NULL CHECK (wording_hash ~ '^[0-9a-f]{64}$'),
  archived_at            TIMESTAMPTZ,
  created_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, purpose_key),
  UNIQUE (workspace_id, id),
  CHECK (applicable_channels <@ ARRAY['email','sms','phone','whatsapp','telegram','slack']::text[])
);
CREATE INDEX crm_consent_purposes_live
  ON crm_consent_purposes(workspace_id, purpose_key) WHERE archived_at IS NULL;

ALTER TABLE association_consent_events
  ADD COLUMN purpose_id UUID,
  ADD COLUMN wording_hash TEXT,
  ADD COLUMN wording_snapshot TEXT,
  ADD COLUMN actor_kind TEXT,
  ADD COLUMN actor_credential_id TEXT,
  ADD COLUMN acting_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE association_consent_events
  ADD CONSTRAINT association_consent_events_purpose_fk
    FOREIGN KEY (workspace_id, purpose_id)
    REFERENCES crm_consent_purposes(workspace_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT association_consent_events_wording_hash_check
    CHECK (wording_hash IS NULL OR wording_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT association_consent_events_wording_snapshot_check
    CHECK (wording_snapshot IS NULL OR length(wording_snapshot) <= 20000),
  ADD CONSTRAINT association_consent_events_actor_kind_check
    CHECK (actor_kind IS NULL OR actor_kind IN
      ('user','assistant','workflow','brain_key','oauth_token','intake_key','home_app','provider'));

CREATE TABLE crm_suppression_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN
                         ('all','email','sms','phone','whatsapp','telegram','slack')),
  action              TEXT NOT NULL CHECK (action IN ('suppressed','released')),
  reason_code         TEXT NOT NULL CHECK (reason_code IN
                         ('manual_do_not_contact','hard_bounce','soft_bounce','complaint',
                          'provider_block','legal','invalid_address','other')),
  source              TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,62}$'),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN
                         ('user','assistant','workflow','brain_key','oauth_token',
                          'intake_key','home_app','provider')),
  actor_credential_id TEXT CHECK (actor_credential_id IS NULL OR length(actor_credential_id) <= 200),
  acting_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  provider            TEXT CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_event_id   TEXT CHECK (provider_event_id IS NULL OR length(provider_event_id) <= 500),
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
                         CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  CHECK ((provider IS NULL) = (provider_event_id IS NULL))
);
CREATE INDEX crm_suppression_contact_timeline
  ON crm_suppression_events(workspace_id, contact_id, channel, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX crm_suppression_provider_event_once
  ON crm_suppression_events(workspace_id, provider, provider_event_id)
  WHERE provider IS NOT NULL;

CREATE TABLE crm_segments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  segment_key        TEXT NOT NULL CHECK (segment_key ~ '^[a-z][a-z0-9_-]{0,62}$'),
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description        TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  entity_kind        TEXT NOT NULL CHECK (entity_kind IN ('person','company','deal')),
  predicate          JSONB NOT NULL CHECK (jsonb_typeof(predicate) = 'object'
                         AND pg_column_size(predicate) <= 65536),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at        TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, segment_key),
  UNIQUE (workspace_id, id)
);
CREATE INDEX crm_segments_live
  ON crm_segments(workspace_id, entity_kind, name, id) WHERE archived_at IS NULL;

ALTER TABLE association_registrations
  ALTER COLUMN order_id DROP NOT NULL,
  ALTER COLUMN order_line_id DROP NOT NULL,
  ALTER COLUMN ticket_id DROP NOT NULL,
  ADD COLUMN source_kind TEXT,
  ADD COLUMN source_id TEXT,
  ADD COLUMN request_fingerprint TEXT;
UPDATE association_registrations
SET source_kind = 'commerce',
    source_id = order_line_id::text,
    request_fingerprint = encode(digest(
      workspace_id::text || ':' || id::text || ':commerce', 'sha256'), 'hex');
ALTER TABLE association_registrations
  ALTER COLUMN source_kind SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ADD CONSTRAINT association_registrations_source_kind_check
    CHECK (source_kind IN ('commerce','manual','form','workflow','import')),
  ADD CONSTRAINT association_registrations_source_pair_check
    CHECK ((source_kind = 'commerce' AND order_id IS NOT NULL AND order_line_id IS NOT NULL
      AND ticket_id IS NOT NULL)
      OR (source_kind <> 'commerce' AND order_id IS NULL AND order_line_id IS NULL
        AND ticket_id IS NULL)),
  ADD CONSTRAINT association_registrations_source_id_check
    CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 500),
  ADD CONSTRAINT association_registrations_request_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE association_registrations
  DROP CONSTRAINT IF EXISTS association_registrations_status_check;
ALTER TABLE association_registrations
  ADD CONSTRAINT association_registrations_status_check
    CHECK (status IN ('reserved','confirmed','cancelled','refunded','checked_in',
      'registered','attended','no_show'));
CREATE UNIQUE INDEX association_registrations_source_once
  ON association_registrations(workspace_id, source_kind, source_id)
  WHERE source_id IS NOT NULL AND source_kind <> 'commerce';

ALTER TABLE association_audit_log
  DROP CONSTRAINT IF EXISTS association_audit_log_actor_kind_check;
ALTER TABLE association_audit_log
  ADD CONSTRAINT association_audit_log_actor_kind_check
    CHECK (actor_kind IN
      ('api_key','user','assistant','workflow','brain_key','oauth_token',
       'intake_key','home_app','provider','import'));
ALTER TABLE association_enquiry_notes
  DROP CONSTRAINT IF EXISTS association_enquiry_notes_actor_kind_check;
ALTER TABLE association_enquiry_notes
  ADD CONSTRAINT association_enquiry_notes_actor_kind_check
    CHECK (actor_kind IN
      ('api_key','user','assistant','workflow','brain_key','oauth_token',
       'intake_key','home_app','provider','import'));

CREATE TABLE crm_domain_event_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL CHECK (event_type IN
                         ('crm.submission.received','crm.submission.updated',
                          'crm.consent.changed','crm.suppression.changed',
                          'crm.entitlement.changed','crm.participation.changed',
                          'crm.deal.stage_changed')),
  event_key           TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 500),
  subject_kind        TEXT NOT NULL CHECK (subject_kind IN
                         ('submission','contact','entitlement','participation','deal')),
  subject_id          UUID NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb
                         CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 32768),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN
                         ('user','assistant','workflow','brain_key','oauth_token',
                          'intake_key','home_app','provider')),
  status              TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','leased','delivered','failed')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner         TEXT,
  leased_until        TIMESTAMPTZ,
  last_error          TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at        TIMESTAMPTZ,
  UNIQUE (workspace_id, event_key)
);
CREATE INDEX crm_domain_events_pending
  ON crm_domain_event_outbox(status, next_attempt_at, created_at, id)
  WHERE status IN ('pending','failed');
CREATE INDEX crm_domain_events_subject
  ON crm_domain_event_outbox(workspace_id, subject_kind, subject_id, occurred_at DESC);

CREATE TABLE crm_import_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  staged_file_id        UUID NOT NULL REFERENCES workspace_files(id) ON DELETE RESTRICT,
  entity_kind           TEXT NOT NULL CHECK (entity_kind IN
                           ('contact','company','deal','operations')),
  status                TEXT NOT NULL DEFAULT 'dry_run'
                           CHECK (status IN ('dry_run','ready','running','paused','completed','cancelled','failed')),
  mapping               JSONB NOT NULL CHECK (jsonb_typeof(mapping) = 'object'
                           AND pg_column_size(mapping) <= 65536),
  mapping_hash          TEXT NOT NULL CHECK (mapping_hash ~ '^[0-9a-f]{64}$'),
  trusted_identity      BOOLEAN NOT NULL DEFAULT false,
  total_rows            INTEGER NOT NULL CHECK (total_rows >= 0),
  processed_rows        INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  succeeded_rows        INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_rows >= 0),
  failed_rows           INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  next_chunk_index      INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
  created_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  UNIQUE (workspace_id, id)
);
CREATE INDEX crm_import_jobs_workspace
  ON crm_import_jobs(workspace_id, status, created_at DESC, id DESC);

CREATE TABLE crm_import_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL,
  chunk_index     INTEGER NOT NULL CHECK (chunk_index >= 0),
  input_hash      TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','completed','failed')),
  processed_rows  INTEGER NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  succeeded_rows  INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_rows >= 0),
  failed_rows     INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, chunk_index),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES crm_import_jobs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE crm_import_errors (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id       UUID NOT NULL,
  row_number   INTEGER NOT NULL CHECK (row_number > 0),
  error_code   TEXT NOT NULL CHECK (error_code ~ '^[a-z][a-z0-9_]{0,62}$'),
  field_key    TEXT CHECK (field_key IS NULL OR field_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  message      TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  row_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(row_snapshot) = 'object' AND pg_column_size(row_snapshot) <= 32768),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, job_id)
    REFERENCES crm_import_jobs(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_import_errors_job
  ON crm_import_errors(workspace_id, job_id, row_number, id);

CREATE TRIGGER crm_intake_definitions_updated_at
  BEFORE UPDATE ON crm_intake_definitions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_consent_purposes_updated_at
  BEFORE UPDATE ON crm_consent_purposes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_segments_updated_at
  BEFORE UPDATE ON crm_segments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_import_jobs_updated_at
  BEFORE UPDATE ON crm_import_jobs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'crm_intake_definitions', 'crm_intake_definition_versions',
    'crm_intake_credentials', 'crm_intake_credential_definitions',
    'crm_intake_idempotency', 'crm_consent_purposes',
    'crm_suppression_events', 'crm_segments', 'crm_domain_event_outbox',
    'crm_import_jobs', 'crm_import_chunks', 'crm_import_errors'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting(''app.current_user_id'', true)::uuid)) WITH CHECK (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = current_setting(''app.current_user_id'', true)::uuid))',
      table_name || '_member', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (COALESCE(current_setting(''app.system_bypass'', true), ''true'') = ''true'') WITH CHECK (COALESCE(current_setting(''app.system_bypass'', true), ''true'') = ''true'')',
      table_name || '_system', table_name
    );
  END LOOP;
END $$;

COMMIT;
