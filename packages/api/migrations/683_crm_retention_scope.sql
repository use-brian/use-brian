BEGIN;
-- [COMP:crm/retention] Spec: crm-operations.md, Retention canonical source floors.
ALTER TABLE crm_retention_runs ADD COLUMN scope_snapshot jsonb;
ALTER TABLE crm_retention_runs ADD CONSTRAINT crm_retention_runs_scope_shape CHECK (
  scope_snapshot IS NULL OR (
    jsonb_typeof(scope_snapshot)='object'
    AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
    AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND coalesce(scope_snapshot->>'sensitivity','') IN ('public','internal','confidential')
    AND jsonb_typeof(scope_snapshot->'compartments')='array'
    AND jsonb_typeof(scope_snapshot->'projectIds')='array'
  )
);
CREATE POLICY crm_retention_department_read ON crm_retention_runs AS RESTRICTIVE FOR SELECT USING(
 NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=crm_retention_runs.workspace_id AND w.department_read_v2)
 OR (scope_snapshot IS NOT NULL AND department_member_source_allows(
  nullif(current_setting('app.current_user_id',true),'')::uuid,workspace_id,scope_snapshot->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(scope_snapshot->'compartments')),(scope_snapshot->>'userId')::uuid)
  AND agent_visibility_allows(workspace_id,(scope_snapshot->>'userId')::uuid,(scope_snapshot->>'assistantId')::uuid))
);
COMMIT;
