-- [COMP:channels/feishu-notifications] Service-only tables, no staff/app-role grants.
BEGIN;
CREATE TABLE feishu_notification_clients (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 integration_id uuid NOT NULL REFERENCES channel_integrations(id) ON DELETE CASCADE,
 app_origin text NOT NULL, approval_evidence text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feishu_notification_recipients (
 client_id uuid NOT NULL REFERENCES feishu_notification_clients(id) ON DELETE CASCADE,
 recipient_key text NOT NULL, open_id text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 PRIMARY KEY(client_id,recipient_key), UNIQUE(client_id,open_id)
);
CREATE TABLE feishu_notification_receipts (
 client_id uuid NOT NULL REFERENCES feishu_notification_clients(id) ON DELETE CASCADE,
 id uuid NOT NULL, request_hash text NOT NULL, recipient_key text NOT NULL,
 open_id text NOT NULL, status text NOT NULL CHECK(status IN('sending','delivered','failed','uncertain','not_sent')),
 message_id text, error_code text, reconciliation_evidence text, reconciled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,id)
);
REVOKE ALL ON feishu_notification_clients,feishu_notification_recipients,feishu_notification_receipts FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON feishu_notification_clients,feishu_notification_recipients,feishu_notification_receipts FROM app_user;
 END IF;
END $$;
COMMIT;
