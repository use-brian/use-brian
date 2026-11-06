-- [COMP:api/channel-recording] Retain authenticated connection attribution for recovery.
BEGIN;
ALTER TABLE channel_integrations
  ADD COLUMN connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN connected_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  ADD COLUMN connected_bot_user_id text;

-- Existing recorder assignments came from authenticated connection/confirmation.
-- An unknown legacy connector is not inferred from workspace or archive ownership.
UPDATE channel_integrations ci SET
  connected_by_user_id = ci.recording_owner_user_id,
  connected_workspace_id = c.workspace_id,
  connected_bot_user_id = ci.bot_user_id
FROM channels c WHERE c.id = ci.channel_id AND ci.channel_type = 'telegram'
  AND ci.recording_owner_user_id IS NOT NULL AND ci.bot_user_id IS NOT NULL;
COMMIT;
