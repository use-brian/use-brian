BEGIN;
CREATE TABLE feed_linkedin_manual_receipts (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 source_revision integer NOT NULL,confirmation_id uuid NOT NULL REFERENCES feed_post_confirmations(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(session_id,source_revision)
);
ALTER TABLE feed_linkedin_manual_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_linkedin_manual_receipts_member ON feed_linkedin_manual_receipts USING(EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=feed_linkedin_manual_receipts.workspace_id AND m.user_id=NULLIF(current_setting('app.current_user_id',true),'')::uuid));
COMMIT;
