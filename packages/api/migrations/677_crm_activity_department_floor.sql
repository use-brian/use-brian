BEGIN;

-- Canonical v2 grants protect both saved activity and current parent.
-- Spec: docs/architecture/features/crm.md, Department-v2 activity and current-member parity.
-- [COMP:crm/activity-scope]
-- Boolean adapter for app-role queries. The underlying grant-map reader stays private.
CREATE FUNCTION department_member_source_allows(actor uuid,w uuid,tier text,teams text[],row_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT (g.value ? w::text) AND department_row_allows(g.value,w,tier,teams,row_user)
  FROM (SELECT department_read_grants_for(actor) AS value) g
$$;

CREATE OR REPLACE FUNCTION crm_activity_scope_allows(a crm_activities,mutation boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT a.scope_held
    AND (a.scope_origin='captured' OR NOT EXISTS(SELECT 1 FROM workspace_access_policies p
      WHERE p.workspace_id=a.workspace_id AND p.classification_mode='strict'))
    AND CASE WHEN current_setting('app.system_bypass',true)='true' THEN true ELSE EXISTS(
      SELECT 1 FROM entities e JOIN workspaces w ON w.id=e.workspace_id JOIN workspace_members m ON m.workspace_id=e.workspace_id
        AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      WHERE e.id=a.entity_id AND e.workspace_id=a.workspace_id
        AND e.kind IN('person','company','deal') AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held
        AND (a.user_id IS NULL OR a.user_id=m.user_id) AND (e.user_id IS NULL OR e.user_id=m.user_id)
        AND CASE WHEN w.department_read_v2 THEN
          department_read_grants() ? a.workspace_id::text
          AND department_row_allows(department_read_grants(),a.workspace_id,a.sensitivity,a.compartments,a.user_id)
          AND department_row_allows(department_read_grants(),e.workspace_id,e.sensitivity,e.compartments,e.user_id)
        ELSE (sensitivity_rank(a.sensitivity)<=sensitivity_rank(m.clearance)
        AND sensitivity_rank(e.sensitivity)<=sensitivity_rank(m.clearance)
        AND (effective_member_team_compartments(m.user_id,m.workspace_id) IS NULL OR
          (a.compartments <@ effective_member_team_compartments(m.user_id,m.workspace_id)
            AND e.compartments <@ effective_member_team_compartments(m.user_id,m.workspace_id)))
        AND context_scope_allows_current_principal(a.workspace_id,a.sensitivity,a.compartments,a.project_ids)
        AND context_scope_allows_current_principal(e.workspace_id,e.sensitivity,e.compartments,e.project_ids)) END
        AND agent_visibility_allows(a.workspace_id,a.user_id,a.assistant_id)
        AND agent_visibility_allows(e.workspace_id,e.user_id,e.assistant_id)
        AND (NOT mutation OR (agent_mutation_scope_allows(a.compartments) AND agent_mutation_scope_allows(e.compartments)))
    ) END
$$;


COMMIT;
