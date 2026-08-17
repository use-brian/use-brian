-- [COMP:api/self-host-feed-cloud-link]
-- The local half of the paid Feed Cloud Link. Social-provider credentials
-- never enter this table; credential_blob holds only a scoped Cloud Link
-- device secret or access token, encrypted with CHANNEL_CREDENTIAL_KEY.

BEGIN;

CREATE TABLE self_host_feed_cloud_links (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  cloud_base_url text NOT NULL,
  local_origin text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'linked', 'plan_required', 'error')),
  device_code text,
  user_code text,
  verification_url text,
  credential_blob bytea,
  hosted_link_id uuid,
  hosted_workspace_id uuid,
  hosted_workspace_name text,
  hosted_assistant_id uuid,
  hosted_assistant_name text,
  hosted_plan text,
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX self_host_feed_cloud_links_assistant_idx
  ON self_host_feed_cloud_links (assistant_id);

ALTER TABLE self_host_feed_cloud_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY self_host_feed_cloud_links_workspace_member
  ON self_host_feed_cloud_links
  USING (
    EXISTS (
      SELECT 1 FROM workspace_members wm
       WHERE wm.workspace_id = self_host_feed_cloud_links.workspace_id
         AND wm.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspace_members wm
       WHERE wm.workspace_id = self_host_feed_cloud_links.workspace_id
         AND wm.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );

COMMIT;
