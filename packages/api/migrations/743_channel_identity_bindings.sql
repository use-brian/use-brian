-- Canonical channel identity bindings: the WeChat early slice.
--
-- Spec: docs/architecture/channels/wechat.md -> "Staff identity" and
-- docs/plans/wechat-staff-access.md §3. Adds the generic `identities` /
-- `identity_bindings` tables from docs/plans/channel-identity-binding.md §2,
-- scoped link-code challenges, a persisted failed-claim limiter, and the
-- WeChat transport generation on `channel_integrations`.
--
-- Creates NO bindings: existing WeChat bots stay unlinked until their user
-- proves the account again. No data is reassigned. Every write is a system
-- write behind an authenticated route; the application role may only read
-- and revoke its own bindings (and owners/admins read their workspace's).

BEGIN;

CREATE TABLE identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
  tenant_key  text NOT NULL,
  subject     text NOT NULL CHECK (length(subject) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_tenant_subject_key UNIQUE (provider, tenant_key, subject)
);

CREATE TABLE identity_bindings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id           uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  account_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid REFERENCES channels(id) ON DELETE CASCADE,
  transport_generation  bigint CHECK (transport_generation IS NULL OR transport_generation > 0),
  proof                 text NOT NULL CHECK (proof IN ('link_code', 'provider_oauth', 'verified_email', 'chat_link', 'qr_pair')),
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  version               bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_bindings_transport_pair CHECK ((channel_id IS NULL) = (transport_generation IS NULL)),
  CONSTRAINT identity_bindings_identity_workspace_key UNIQUE NULLS NOT DISTINCT (identity_id, workspace_id)
);
CREATE INDEX idx_identity_bindings_account ON identity_bindings (account_id);
CREATE INDEX idx_identity_bindings_channel ON identity_bindings (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX idx_identity_bindings_workspace ON identity_bindings (workspace_id) WHERE workspace_id IS NOT NULL;

-- A WeChat binding is always transport-bound and workspace-scoped: the QR
-- proof belongs to one bot in one workspace, so a default (all-workspaces)
-- binding or one detached from its transport generation is refused.
CREATE FUNCTION identity_bindings_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  identity_provider text;
BEGIN
  SELECT provider INTO identity_provider FROM identities WHERE id = NEW.identity_id;
  IF identity_provider = 'wechat' AND (
    NEW.workspace_id IS NULL OR NEW.channel_id IS NULL OR NEW.transport_generation IS NULL
  ) THEN
    RAISE EXCEPTION 'wechat identity bindings require a workspace, a channel and a transport generation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF identity_provider = 'wechat' AND NEW.proof NOT IN ('qr_pair', 'link_code') THEN
    RAISE EXCEPTION 'wechat identity bindings accept only qr_pair or link_code proof'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_bindings_scope_guard
  BEFORE INSERT OR UPDATE ON identity_bindings
  FOR EACH ROW EXECUTE FUNCTION identity_bindings_scope_guard();

CREATE TRIGGER set_identities_updated_at BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_identity_bindings_updated_at BEFORE UPDATE ON identity_bindings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE channel_identity_challenges (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL CHECK (provider = 'wechat'),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  transport_generation  bigint NOT NULL CHECK (transport_generation > 0),
  account_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_digest           bytea NOT NULL,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  claimed_at            timestamptz,
  claimed_identity_id   uuid REFERENCES identities(id) ON DELETE SET NULL,
  revoked_at            timestamptz
);
CREATE UNIQUE INDEX idx_channel_identity_challenges_open
  ON channel_identity_challenges (account_id, channel_id)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_channel_identity_challenges_digest
  ON channel_identity_challenges (channel_id, code_digest);
CREATE INDEX idx_channel_identity_challenges_minted
  ON channel_identity_challenges (account_id, channel_id, created_at);

CREATE TABLE channel_identity_claim_failures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  failed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_channel_identity_claim_failures_window
  ON channel_identity_claim_failures (channel_id, subject, failed_at);

ALTER TABLE channel_integrations
  ADD COLUMN identity_generation bigint NOT NULL DEFAULT 1 CHECK (identity_generation > 0),
  ADD COLUMN last_identity_pairing_id text;

-- RLS: the application role reads and revokes only its own bindings;
-- workspace owners/admins read their workspace's bindings for the per-channel
-- summary. INSERT/DELETE have no application policy (system writes only).
ALTER TABLE identity_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_bindings_own_read ON identity_bindings FOR SELECT
  USING (account_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY identity_bindings_admin_read ON identity_bindings FOR SELECT
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members
     WHERE user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
       AND role IN ('owner', 'admin')
  ));
CREATE POLICY identity_bindings_own_revoke ON identity_bindings FOR UPDATE
  USING (account_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY identities_bound_read ON identities FOR SELECT
  USING (id IN (
    SELECT identity_id FROM identity_bindings
     WHERE account_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  ));

ALTER TABLE channel_identity_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_identity_claim_failures ENABLE ROW LEVEL SECURITY;

COMMIT;
