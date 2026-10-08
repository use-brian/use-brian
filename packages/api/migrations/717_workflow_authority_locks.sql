BEGIN;
-- [COMP:api/workflow-authority] Locks for an exact actor-owned retained source.
CREATE FUNCTION lock_workflow_authority_inputs(w uuid,run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR NOT EXISTS(SELECT 1 FROM workflow_runs r JOIN workflows f ON f.id=r.workflow_id AND f.workspace_id=r.workspace_id
   WHERE r.workspace_id=w AND r.id=run AND coalesce(r.triggered_by,f.created_by)=actor) THEN
  RAISE EXCEPTION 'workflow_authority_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM id FROM workflow_runs WHERE workspace_id=w AND id=run FOR SHARE;
 PERFORM id FROM workflows WHERE workspace_id=w AND id=(SELECT workflow_id FROM workflow_runs WHERE id=run) FOR SHARE;
 PERFORM id FROM goals WHERE workspace_id=w AND id=(SELECT source_goal_id FROM workflow_runs WHERE id=run) FOR SHARE;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w ORDER BY user_id FOR SHARE;
 -- Parent UPDATE locks also block new FK-bound membership/configuration rows.
 PERFORM id FROM assistants WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM workspace_groups WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM workspace_projects WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM department_edges WHERE workspace_id=w ORDER BY id FOR SHARE;
 PERFORM id FROM workspace_access_grants WHERE workspace_id=w ORDER BY id FOR SHARE;
 PERFORM m.group_id FROM workspace_group_members m JOIN workspace_groups g ON g.id=m.group_id WHERE g.workspace_id=w ORDER BY m.group_id,m.user_id FOR SHARE OF m;
 PERFORM a.group_id FROM workspace_group_assistants a JOIN workspace_groups g ON g.id=a.group_id WHERE g.workspace_id=w ORDER BY a.group_id,a.assistant_id FOR SHARE OF a;
 PERFORM b.group_id FROM workspace_group_compartment_grants b JOIN workspace_groups g ON g.id=b.group_id WHERE g.workspace_id=w ORDER BY b.group_id FOR SHARE OF b;
 PERFORM m.project_id FROM workspace_project_members m JOIN workspace_projects p ON p.id=m.project_id WHERE p.workspace_id=w ORDER BY m.project_id,m.user_id FOR SHARE OF m;
 PERFORM a.project_id FROM assistant_project_grants a JOIN workspace_projects p ON p.id=a.project_id WHERE p.workspace_id=w ORDER BY a.project_id,a.assistant_id FOR SHARE OF a;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR NOT EXISTS(SELECT 1 FROM workflow_runs r JOIN workflows f ON f.id=r.workflow_id AND f.workspace_id=r.workspace_id
   WHERE r.workspace_id=w AND r.id=run AND coalesce(r.triggered_by,f.created_by)=actor)
  OR workflow_history_evidence_visible(run) IS NOT TRUE THEN
  RAISE EXCEPTION 'workflow_authority_unavailable' USING ERRCODE='42501'; END IF;
END $$;
COMMIT;
