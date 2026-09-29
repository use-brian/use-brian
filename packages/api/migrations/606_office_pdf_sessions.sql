-- Owner-only, 24-hour Office PDF editing sessions and their durable purge
-- ledger. [COMP:api/office-pdf-sessions] [COMP:api/office-pdf-purge]
BEGIN;

ALTER TABLE office_artifacts
  DROP CONSTRAINT IF EXISTS office_artifacts_family_check;
ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_family_check
  CHECK (family IN ('document', 'presentation', 'spreadsheet', 'pdf'));

ALTER TABLE office_artifacts
  DROP CONSTRAINT IF EXISTS office_artifacts_mode_check;
ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_mode_check
  CHECK (mode IN ('artifact', 'template', 'session'));

ALTER TABLE office_artifacts
  DROP CONSTRAINT IF EXISTS office_artifacts_default_workspace_role_check;
ALTER TABLE office_artifacts
  ADD CONSTRAINT office_artifacts_default_workspace_role_check
  CHECK (default_workspace_role IN ('view', 'comment', 'edit', 'deny'));

ALTER TABLE office_artifacts
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN pdf_session_idempotency_key TEXT;

ALTER TABLE office_artifacts
  ADD CONSTRAINT office_pdf_session_shape_check CHECK (
    (family = 'pdf') = (mode = 'session')
    AND (
      mode <> 'session'
      AND expires_at IS NULL
      OR mode = 'session'
      AND expires_at IS NOT NULL
      AND expires_at = created_at + interval '24 hours'
      AND template_version_id IS NULL
      AND legal_hold = FALSE
      AND default_workspace_role = 'deny'
      AND length(pdf_session_idempotency_key) BETWEEN 8 AND 255
    )
    AND (mode = 'session' OR pdf_session_idempotency_key IS NULL)
  );

CREATE UNIQUE INDEX idx_office_pdf_session_idempotency
  ON office_artifacts (workspace_id, owner_user_id, pdf_session_idempotency_key)
  WHERE mode = 'session';

CREATE TABLE office_pdf_session_assets (
  artifact_id           UUID NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_id               UUID NOT NULL REFERENCES workspace_files(id) ON DELETE RESTRICT,
  role                  TEXT NOT NULL CHECK (role IN ('source','signature','snapshot','preview','release')),
  content_sha256        TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, file_id),
  UNIQUE (file_id)
);

CREATE TABLE office_pdf_purge_objects (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL,
  workspace_id          UUID NOT NULL,
  owner_user_id         UUID NOT NULL,
  file_id               UUID NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('source','signature','snapshot','preview','release')),
  storage_uri           TEXT CHECK (storage_uri IS NULL OR length(storage_uri) BETWEEN 1 AND 4096),
  content_sha256        TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token           UUID,
  lease_expires_at      TIMESTAMPTZ,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code       TEXT,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, file_id),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX idx_office_pdf_sessions_due
  ON office_artifacts (expires_at, id)
  WHERE mode = 'session' AND lifecycle_state = 'active';
CREATE INDEX idx_office_pdf_session_assets_artifact_role
  ON office_pdf_session_assets (artifact_id, role, created_at);
CREATE INDEX idx_office_pdf_purge_due
  ON office_pdf_purge_objects (next_attempt_at, created_at)
  WHERE completed_at IS NULL;
CREATE INDEX idx_office_pdf_purge_lease
  ON office_pdf_purge_objects (lease_expires_at)
  WHERE completed_at IS NULL AND lease_token IS NOT NULL;

ALTER TABLE office_pdf_session_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_pdf_purge_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_pdf_session_assets_owner ON office_pdf_session_assets
  USING (
    owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM office_artifacts a
       WHERE a.id = office_pdf_session_assets.artifact_id
         AND a.workspace_id = office_pdf_session_assets.workspace_id
         AND a.owner_user_id = office_pdf_session_assets.owner_user_id
         AND a.mode = 'session'
         AND a.lifecycle_state = 'active'
         AND now() < a.expires_at
    )
  );

-- No user policy is created for the internal purge queue. Its worker uses the
-- service database role, and queue rows deliberately outlive all source FKs.

-- Session ownership is part of the canonical artifact scope predicate. Every
-- RESTRICTIVE child-table policy installed by migration 596 therefore inherits
-- the same owner/active/expiry gate for reads and writes.
CREATE OR REPLACE FUNCTION office_artifact_scope_allows(artifact uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=artifact AND a.workspace_id=w
    AND (a.mode<>'session' OR (
      a.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      AND a.lifecycle_state='active' AND now()<a.expires_at
      AND a.family='pdf' AND a.default_workspace_role='deny'
    ))
    AND office_root_scope_allows(a.id,a.workspace_id,a.sensitivity,a.compartments,a.project_ids,
      a.visibility_user_ids,a.visibility_assistant_ids,mutation))
$$;

-- Replace permissive broad-member policies. A second policy would OR with the
-- existing one and could not narrow a session row.
DROP POLICY IF EXISTS office_artifacts_context_member ON office_artifacts;
CREATE POLICY office_artifacts_context_member ON office_artifacts USING (
  mode<>'session' OR (
    owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND lifecycle_state='active' AND now()<expires_at
  )
);

DROP POLICY IF EXISTS office_versions_context_member ON office_artifact_versions;
CREATE POLICY office_versions_context_member ON office_artifact_versions USING (
  NOT EXISTS (SELECT 1 FROM office_artifacts a WHERE a.id=artifact_id AND a.mode='session')
  OR office_artifact_scope_allows(artifact_id,workspace_id,false)
);

DROP POLICY IF EXISTS office_sources_context_member ON office_artifact_sources;
CREATE POLICY office_sources_context_member ON office_artifact_sources USING (
  NOT EXISTS (SELECT 1 FROM office_artifacts a WHERE a.id=artifact_id AND a.mode='session')
  OR office_artifact_scope_allows(artifact_id,workspace_id,false)
);

DO $$ DECLARE tab text; policy_name text; BEGIN
  FOR tab,policy_name IN SELECT * FROM (VALUES
    ('office_artifact_grants','office_grants_member'),
    ('office_audit_events','office_audit_member'),
    ('office_collab_documents','office_collab_member'),
    ('office_comment_threads','office_comment_threads_member'),
    ('office_suggestions','office_suggestions_member'),
    ('office_generation_jobs','office_generation_jobs_member'),
    ('office_claims','office_claims_member'),
    ('office_media_uses','office_media_uses_member'),
    ('office_release_records','office_release_records_member'),
    ('office_offline_packages','office_offline_packages_owner')
  ) AS policies(tab,policy_name) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',policy_name,tab);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting(''app.current_user_id'',true),'''')::uuid) AND office_artifact_scope_allows(artifact_id,workspace_id,false))',
      policy_name,tab
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS office_comment_messages_member ON office_comment_messages;
CREATE POLICY office_comment_messages_member ON office_comment_messages USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  AND office_child_scope_allows(thread_id,workspace_id,'thread',false)
);

DROP POLICY IF EXISTS office_generation_events_member ON office_generation_events;
CREATE POLICY office_generation_events_member ON office_generation_events USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  AND office_child_scope_allows(job_id,workspace_id,'job',false)
);

DROP POLICY IF EXISTS office_generation_steering_member ON office_generation_steering;
CREATE POLICY office_generation_steering_member ON office_generation_steering USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  AND office_child_scope_allows(job_id,workspace_id,'job',false)
);

COMMIT;
