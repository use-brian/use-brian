BEGIN;
-- [COMP:workflow/context-scope]
-- Spec: docs/architecture/features/workflow.md, Workflow run department context floor.
CREATE FUNCTION guard_workflow_run_department_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_group uuid; selected_key text; captured text[];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.workflow_id,NEW.context_compartments)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.workflow_id,OLD.context_compartments) THEN
      RAISE EXCEPTION 'workflow_run_department_immutable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT w.context_group_id,g.compartment_key INTO selected_group,selected_key
    FROM workflows w LEFT JOIN workspace_groups g ON g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.kind='team'
    WHERE w.id=NEW.workflow_id AND w.workspace_id=NEW.workspace_id FOR SHARE OF w;
  IF NOT FOUND OR (selected_group IS NOT NULL AND selected_key IS NULL) THEN
    RAISE EXCEPTION 'workflow_run_department_unavailable' USING ERRCODE='42501';
  END IF;
  captured=CASE WHEN selected_group IS NULL THEN ARRAY[]::text[] ELSE ARRAY[selected_key] END;
  IF (NEW.context_group_id IS NOT NULL AND NEW.context_group_id IS DISTINCT FROM selected_group)
    OR (cardinality(NEW.context_compartments)>0 AND NEW.context_compartments IS DISTINCT FROM captured) THEN
    RAISE EXCEPTION 'workflow_run_department_mismatch' USING ERRCODE='42501';
  END IF;
  NEW.context_group_id=selected_group;
  NEW.context_compartments=captured;
  RETURN NEW;
END;
$$;
-- Run before the existing source and context validators.
CREATE TRIGGER capture_workflow_run_department BEFORE INSERT OR UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_run_department_context();

CREATE FUNCTION workflow_run_department_visible(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT id FROM workflow_runs WHERE id=target
    UNION
    SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
  ) SELECT EXISTS(SELECT 1 FROM workflow_runs r JOIN workspace_members m ON m.workspace_id=r.workspace_id
      WHERE r.id=target AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
    AND NOT EXISTS(
      SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id JOIN workspaces ws ON ws.id=r.workspace_id
        LEFT JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
        LEFT JOIN workspace_groups g ON g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.kind='team'
      WHERE ws.department_read_v2 AND (
        w.id IS NULL OR (r.context_group_id IS NOT NULL AND NOT ('team:'||r.context_group_id::text)=ANY(r.context_compartments))
        OR (w.context_group_id IS NOT NULL AND g.compartment_key IS NULL)
        OR NOT coalesce(department_row_allows(department_read_grants(),r.workspace_id,'public',r.context_compartments,NULL),false)
        OR NOT coalesce(department_row_allows(department_read_grants(),r.workspace_id,'public',
          CASE WHEN w.context_group_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.compartment_key] END,NULL),false)
      ))
$$;
CREATE POLICY workflow_runs_department_read ON workflow_runs AS RESTRICTIVE FOR SELECT USING(workflow_run_department_visible(id));
CREATE POLICY workflow_steps_department_read ON workflow_step_runs AS RESTRICTIVE FOR SELECT USING(workflow_run_department_visible(run_id));
CREATE POLICY workflow_copies_department_read ON workflow_run_copy_sources AS RESTRICTIVE FOR SELECT
  USING(workflow_run_department_visible(run_id) AND workflow_run_department_visible(source_run_id));
COMMIT;
