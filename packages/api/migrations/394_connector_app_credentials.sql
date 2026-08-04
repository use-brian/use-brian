-- 394_connector_app_credentials.sql  (OPEN tables -> use-brian/packages/api/migrations/)
--
-- Workspace-owned OAuth *app* credentials for a built-in connector.
--
-- Until now a built-in connector's app pair (client id + secret) could only
-- come from deployment config: `~/.usebrian/connectors.config.json` or
-- `<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET` env (connector-config.ts). That is
-- fine for a self-host whose operator owns the process, and wrong for the
-- hosted product, where the person who registers the Entra app is a customer
-- admin who cannot reach the environment at all. This table is the third
-- source: a workspace brings its own app, pasted in Studio -> Connectors.
--
-- Scope is (workspace_id, provider). Per-workspace rather than per-user
-- because the Entra registration is a company asset: one admin registers it,
-- every member of that workspace consents against it.
--
-- `client_secret_ciphertext` is an AES-256-GCM blob (iv || tag || ciphertext)
-- under CHANNEL_CREDENTIAL_KEY (credential-crypto.ts) — the same envelope
-- every other connector secret uses. Never plaintext.
--
-- The pair is ALSO copied into the connector_instance credentials envelope at
-- exchange time (packMsGraphTokens). That is not redundancy for its own sake:
-- the runtime refresh path (mcp/inject.ts) knows a userId and an instance, not
-- a workspace, so a token can only be rotated by the app that minted it if
-- that app travels with the token. This table is the *configuration* surface;
-- the envelope copy is what keeps an existing connection alive after the
-- workspace edits its app.
--
-- See docs/architecture/integrations/msgraph.md -> "Auth".

BEGIN;

CREATE TABLE connector_app_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Connector id from OFFICIAL_CONNECTORS (e.g. 'msgraph'). Deliberately not a
  -- CHECK-constrained enum: the registry is the source of truth for which
  -- providers may be configured this way (CONFIGURABLE_APP_CREDENTIAL_
  -- CONNECTORS), and a DB enum would be a second list to drift.
  provider                 TEXT NOT NULL,
  client_id                TEXT NOT NULL,
  -- AES-256-GCM under CHANNEL_CREDENTIAL_KEY. Never plaintext.
  client_secret_ciphertext BYTEA NOT NULL,
  -- Provider-specific authority hint. For msgraph this is the Entra directory
  -- (tenant) id; absent means the `organizations` multi-tenant authority.
  tenant_id                TEXT,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

CREATE INDEX idx_connector_app_credentials_ws
  ON connector_app_credentials (workspace_id, provider);

-- Workspace-member read. WRITES are additionally gated to owner/admin in the
-- route layer (isWorkspaceConnectorAdmin) — RLS is the tenancy boundary, the
-- role check is the authority boundary, and they answer different questions.
ALTER TABLE connector_app_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_app_credentials_workspace_member ON connector_app_credentials
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
    FROM workspace_members
    WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid))
  WITH CHECK (workspace_id IN (
    SELECT workspace_members.workspace_id
    FROM workspace_members
    WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid));

COMMIT;
