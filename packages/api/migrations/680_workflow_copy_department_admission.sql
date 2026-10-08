BEGIN;
-- [COMP:workflow/context-scope]
-- Spec: docs/architecture/features/workflow.md, Workflow outcome-copy department admission.
CREATE FUNCTION workflow_run_department_allows(target uuid,actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT id FROM workflow_runs WHERE id=target
    UNION
    SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
  ) SELECT EXISTS(SELECT 1 FROM workflow_runs r JOIN workspace_members m ON m.workspace_id=r.workspace_id
      WHERE r.id=target AND m.user_id=actor)
    AND NOT EXISTS(
      SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id JOIN workspaces ws ON ws.id=r.workspace_id
        LEFT JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
        LEFT JOIN workspace_groups g ON g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.kind='team'
      WHERE ws.department_read_v2 AND (
        w.id IS NULL OR (r.context_group_id IS NOT NULL AND NOT ('team:'||r.context_group_id::text)=ANY(r.context_compartments))
        OR (w.context_group_id IS NOT NULL AND g.compartment_key IS NULL)
        OR NOT coalesce(department_row_allows(department_read_grants_for(actor),r.workspace_id,'public',r.context_compartments,NULL),false)
        OR NOT coalesce(department_row_allows(department_read_grants_for(actor),r.workspace_id,'public',
          CASE WHEN w.context_group_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.compartment_key] END,NULL),false)
      ))
$$;

REVOKE ALL ON FUNCTION workflow_run_department_allows(uuid,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION workflow_run_department_visible(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT workflow_run_department_allows(target,nullif(current_setting('app.current_user_id',true),'')::uuid)
$$;
CREATE FUNCTION guard_workflow_copy_department() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid;
BEGIN
 SELECT coalesce(r.triggered_by,w.created_by) INTO actor FROM workflow_runs r
 JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
 WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id FOR SHARE OF r,w;
 IF actor IS NULL OR NOT workflow_run_department_allows(NEW.run_id,actor)
   OR NOT workflow_run_department_allows(NEW.source_run_id,actor) THEN
   RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
-- Keep canonical source identity validation before department admission.
CREATE TRIGGER workflow_department_copy_admission BEFORE INSERT ON workflow_run_copy_sources
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_copy_department();
COMMIT;
