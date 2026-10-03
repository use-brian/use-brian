-- Agent configuration (`configure`) is default-on for every workspace primary
-- assistant. Creation now seeds it (db/users.ts, db/workspace-store.ts); this
-- backfills existing primaries. A primary that has ANY configure row, active
-- or revoked, is skipped: an owner's deliberate switch-off is never undone.
-- Spec: docs/architecture/integrations/agent-capability-surface.md
--       -> "The configure capability"
BEGIN;
WITH grantors AS (
  SELECT a.id, COALESCE(a.owner_user_id,
    (SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id = a.workspace_id
     ORDER BY (wm.role = 'owner') DESC, wm.joined_at LIMIT 1),
    (SELECT ac.granted_by_user_id FROM assistant_capabilities ac
     WHERE ac.assistant_id = a.id ORDER BY ac.granted_at LIMIT 1)
  ) AS user_id
  FROM assistants a
  WHERE a.kind = 'primary'
)
INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
SELECT g.id, 'configure', g.user_id, 'agent configuration - default-on for primaries (backfill)'
FROM grantors g
WHERE g.user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM assistant_capabilities existing
  WHERE existing.assistant_id = g.id AND existing.capability = 'configure'
)
ON CONFLICT (assistant_id, capability) WHERE revoked_at IS NULL DO NOTHING;
COMMIT;
