-- Explicit publication consent is separate from source-read and audience grants.
-- Every approval is retained; revocation/reapproval never rewrites its provenance.
BEGIN;
-- A generation remains even when no approval exists: revoke fences pending dialogs.
CREATE TABLE workflow_publication_consent_states (
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (workflow_id, user_id)
);
ALTER TABLE workflow_publication_consent_states ENABLE ROW LEVEL SECURITY;
CREATE TABLE workflow_publication_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_revision text NOT NULL,
  channel_type text NOT NULL CHECK (channel_type = 'telegram'),
  channel_id text NOT NULL,
  channel_integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > approved_at)
);
CREATE INDEX workflow_publication_consents_lookup
  ON workflow_publication_consents(workflow_id, step_id, approved_by_user_id)
  WHERE revoked_at IS NULL;
-- Only the authenticated API consent routes write this server-owned table.
-- No general workflow JSON, agent tool or member SQL can mint consent.
ALTER TABLE workflow_publication_consents ENABLE ROW LEVEL SECURITY;
COMMIT;
