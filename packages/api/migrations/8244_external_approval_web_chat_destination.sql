BEGIN;
-- Allow verified personal web-chat destinations (session id) in addition to
-- the Approvals-panel inbox (`channel_id = 'queue'`). Messaging destinations
-- still require a pinned channel_integration_id.
ALTER TABLE workspace_external_approval_sources
  DROP CONSTRAINT IF EXISTS workspace_external_approval_sources_check;
ALTER TABLE workspace_external_approval_sources
  ADD CONSTRAINT workspace_external_approval_sources_check
  CHECK ((channel_type='web' AND channel_integration_id IS NULL AND length(channel_id) > 0)
    OR (channel_type<>'web' AND channel_integration_id IS NOT NULL AND length(channel_id) > 0));
COMMIT;
