-- [COMP:api/policy-epoch] Existing workspaces need the same lockable epoch
-- as workspaces created after the epoch triggers were installed.
BEGIN;
INSERT INTO application_policy_workspace_epochs(workspace_id,revision)
SELECT w.id,nextval('application_policy_revision_seq')
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM application_policy_workspace_epochs epoch WHERE epoch.workspace_id=w.id
)
ON CONFLICT(workspace_id) DO NOTHING;
COMMIT;
