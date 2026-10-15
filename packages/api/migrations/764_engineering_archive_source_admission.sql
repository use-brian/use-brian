BEGIN;
ALTER FUNCTION engineering_archive_source_current(uuid) RENAME TO engineering_archive_source_current_before_assistant;
CREATE FUNCTION engineering_archive_source_current(event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT engineering_archive_source_current_before_assistant(event) AND EXISTS(
  SELECT 1 FROM programmatic_archive_events e JOIN workspace_files f ON f.id=e.file_id JOIN workspaces w ON w.id=f.workspace_id
   JOIN assistants a ON a.id=f.created_by_assistant_id AND a.workspace_id=w.id
  WHERE e.id=event AND NOT EXISTS(SELECT 1 FROM unnest(f.compartments) label WHERE
   CASE WHEN label LIKE 'team:%' AND w.department_read_v2 THEN NOT EXISTS(
    SELECT 1 FROM department_edges edge JOIN workspace_groups d ON d.id=edge.department_id
     WHERE edge.workspace_id=w.id AND d.compartment_key=label AND d.status='active' AND edge.assistant_id=a.id
      AND (edge.expires_at IS NULL OR edge.expires_at>now()) AND sensitivity_rank(edge.clearance)>=sensitivity_rank(f.sensitivity))
   WHEN label LIKE 'project:%' THEN NOT project_member_live(substr(label,9)::uuid,'assistant',a.id)
   ELSE false END))
$$;
-- Policies retain a function OID across rename; explicitly bind the new gate.
DROP POLICY engineering_history_current_source ON programmatic_archive_events;
CREATE POLICY engineering_history_current_source ON programmatic_archive_events AS RESTRICTIVE FOR SELECT USING(engineering_archive_source_current(id));
DROP POLICY engineering_file_current_source ON workspace_files;
CREATE POLICY engineering_file_current_source ON workspace_files AS RESTRICTIVE FOR SELECT USING(
 purpose<>'engineering_archive' OR current_setting('app.engineering_archive_publication',true)=id::text OR engineering_archive_source_current(id));
COMMIT;
