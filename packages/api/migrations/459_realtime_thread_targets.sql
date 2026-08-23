-- 459_realtime_thread_targets.sql
--
-- Temporary, channel-neutral authority for one exact provider thread.
-- Spec: docs/architecture/brain/ingest-pipeline.md

BEGIN;

CREATE TABLE realtime_thread_targets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assistant_id       uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  channel_type       text NOT NULL,
  conversation_ref   text NOT NULL,
  thread_ref         text NOT NULL,
  task_ids            uuid[] NOT NULL DEFAULT '{}',
  context_text       text,
  expires_at         timestamptz NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_thread_targets_channel_type_nonempty CHECK (length(channel_type) BETWEEN 1 AND 64),
  CONSTRAINT realtime_thread_targets_channel_type_canonical CHECK (channel_type = lower(channel_type)),
  CONSTRAINT realtime_thread_targets_conversation_nonempty CHECK (length(conversation_ref) BETWEEN 1 AND 256),
  CONSTRAINT realtime_thread_targets_thread_nonempty CHECK (length(thread_ref) BETWEEN 1 AND 256),
  CONSTRAINT realtime_thread_targets_task_count CHECK (cardinality(task_ids) <= 50),
  CONSTRAINT realtime_thread_targets_context_size CHECK (context_text IS NULL OR length(context_text) <= 20000),
  UNIQUE (workspace_id, assistant_id, channel_type, conversation_ref, thread_ref)
);

CREATE INDEX idx_realtime_thread_targets_active
  ON realtime_thread_targets (workspace_id, assistant_id, channel_type, conversation_ref, thread_ref, expires_at);

CREATE INDEX idx_realtime_thread_targets_expiry
  ON realtime_thread_targets (expires_at);

CREATE OR REPLACE FUNCTION realtime_thread_targets_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_thread_targets_set_updated_at_trg
  BEFORE UPDATE ON realtime_thread_targets
  FOR EACH ROW EXECUTE FUNCTION realtime_thread_targets_set_updated_at();

ALTER TABLE realtime_thread_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_thread_targets FORCE ROW LEVEL SECURITY;

CREATE POLICY realtime_thread_targets_workspace_member ON realtime_thread_targets
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ))
  WITH CHECK (workspace_id IN (
    SELECT workspace_members.workspace_id FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  ));

CREATE POLICY realtime_thread_targets_system_bypass ON realtime_thread_targets
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true')
  WITH CHECK (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

COMMIT;
