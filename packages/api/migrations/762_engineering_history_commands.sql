BEGIN;
ALTER TABLE programmatic_capture_receipts ADD COLUMN archive_sequence bigint;
ALTER TABLE programmatic_archive_events ADD COLUMN revision bigint NOT NULL DEFAULT 1;
CREATE TABLE engineering_history_commands (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 principal_ref text NOT NULL,
 idempotency_key uuid NOT NULL,
 event_id uuid NOT NULL REFERENCES programmatic_archive_events(id) ON DELETE CASCADE,
 request_digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,principal_ref,idempotency_key)
);
ALTER TABLE engineering_history_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY engineering_history_command_actor ON engineering_history_commands USING(actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(actor_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON programmatic_archive_events,engineering_history_commands TO app_user;
  GRANT USAGE,SELECT ON SEQUENCE programmatic_archive_events_sequence_seq TO app_user;
 END IF;
END $$;
COMMIT;
