-- 388: Backfill the default "General" room for existing workspaces
-- (multiplayer chat T6/D4 — docs/plans/multiplayer-chat.md).
--
-- Every NEW workspace now provisions a General room inside its create
-- transaction (workspace-store.ts `create()`, users.ts `findOrCreateUser`).
-- This backfill grandfathers existing workspaces so the Chat app's Workspace
-- tab always lands somewhere alive. The room is an ordinary workspace-shared
-- chat session — no new table; `title_manually_set` keeps the auto-titler off
-- the default name.
--
-- Idempotent, and deliberately conservative: a workspace that already has ANY
-- shared chat room is left alone (its Workspace tab is already alive, and the
-- General room is not re-provisioned after deletion — T12). Workspaces
-- without a primary assistant or an owner are skipped, not failed.

BEGIN;

INSERT INTO sessions
  (assistant_id, user_id, channel_type, channel_id, app_id,
   app_origin, visibility, workspace_id, effective_clearance, title,
   title_manually_set)
SELECT p.id,
       w.owner_user_id,
       'web',
       gen_random_uuid()::text,
       'Use Brian',
       'chat',
       'workspace',
       w.id,
       p.clearance,
       'General',
       true
FROM workspaces w
JOIN (
  SELECT DISTINCT ON (workspace_id) id, workspace_id, clearance
  FROM assistants
  WHERE kind = 'primary' AND workspace_id IS NOT NULL
  ORDER BY workspace_id, created_at
) p ON p.workspace_id = w.id
WHERE w.owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sessions s
     WHERE s.workspace_id = w.id
       AND s.visibility = 'workspace'
       AND s.channel_type = 'web'
       AND s.app_origin = 'chat'
  );

COMMIT;
