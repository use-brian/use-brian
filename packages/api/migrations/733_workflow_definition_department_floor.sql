-- [COMP:workflow/context-scope] Department floor for workflow definitions.
-- Spec: docs/architecture/features/workflow.md, "Workflow definition department floor".
-- A department-context workflow (name, definition, prompts) is readable and
-- editable only by principals that may read its department, matching the run
-- floor of migration 679. General workflows and legacy workspaces are unchanged.
-- An archived or missing department fails closed. System (owner) lanes are unaffected.
BEGIN;

CREATE FUNCTION workflow_definition_department_allows(target_workspace uuid, target_group uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN target_group IS NULL THEN true
    WHEN NOT coalesce((SELECT department_read_v2 FROM workspaces WHERE id=target_workspace),false) THEN true
    ELSE coalesce((
      SELECT department_row_allows(department_read_grants(),target_workspace,'public',ARRAY[g.compartment_key],NULL)
        FROM workspace_groups g
       WHERE g.id=target_group AND g.workspace_id=target_workspace AND g.kind='team' AND g.compartment_key IS NOT NULL
    ),false)
  END
$$;

CREATE POLICY workflows_department_floor ON workflows AS RESTRICTIVE FOR ALL
  USING (workflow_definition_department_allows(workspace_id,context_group_id))
  WITH CHECK (workflow_definition_department_allows(workspace_id,context_group_id));

COMMIT;
