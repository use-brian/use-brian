BEGIN;
-- One immutable producer authority per exact task version. No historical
-- created_by inference, default selection, or backfill of old tasks/goals.
CREATE TABLE goal_task_source_authority (
  task_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proof jsonb NOT NULL,
  goal_id uuid UNIQUE
);
ALTER TABLE goal_task_source_authority ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION protect_goal_task_source_authority() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.proof IS DISTINCT FROM OLD.proof OR (OLD.goal_id IS NOT NULL AND NEW.goal_id IS DISTINCT FROM OLD.goal_id)
  THEN RAISE EXCEPTION 'goal_source_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goal_task_source_immutable BEFORE UPDATE ON goal_task_source_authority
  FOR EACH ROW EXECUTE FUNCTION protect_goal_task_source_authority();
CREATE FUNCTION goal_task_scope_allows(gid uuid,actor uuid,teams text[] DEFAULT NULL,projects uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM goal_task_source_authority s
    WHERE s.goal_id=gid AND NOT EXISTS (
      SELECT 1 FROM tasks t JOIN workspace_members m ON m.workspace_id=t.workspace_id AND m.user_id=actor
      WHERE t.id=s.task_id AND t.workspace_id=s.workspace_id
        AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held
        AND t.user_id IS NULL AND t.assistant_id IS NULL
        AND sensitivity_rank(t.sensitivity)<=sensitivity_rank(m.clearance)
        AND (effective_member_read_compartments(actor,t.workspace_id) IS NULL OR t.compartments <@ effective_member_read_compartments(actor,t.workspace_id))
        AND (teams IS NULL OR t.compartments <@ teams) AND (projects IS NULL OR t.project_ids <@ projects)
        AND to_jsonb(t)::text=s.proof->>'snapshot'
    ))
$$;
REVOKE ALL ON FUNCTION goal_task_scope_allows(uuid,uuid,text[],uuid[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION goal_crm_scope_allows(goal_id uuid,actor uuid,team_grant text[] DEFAULT NULL,project_grant uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM goals g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=actor WHERE g.id=goal_id)
 AND goal_task_scope_allows(goal_id,actor,team_grant,project_grant)
 AND NOT EXISTS(SELECT 1 FROM goal_crm_event_sources s JOIN goals g ON g.id=s.goal_id
   LEFT JOIN crm_domain_event_outbox e ON e.id=s.event_id
   WHERE s.goal_id=goal_crm_scope_allows.goal_id AND (s.workspace_id<>g.workspace_id OR e.id IS NULL
     OR s.event_binding IS DISTINCT FROM goal_crm_event_binding(e)
     OR NOT crm_event_scope_allows(s.event_id,actor,team_grant,project_grant)))
$$;
-- Read projection additionally clips to the current runtime GUCs. System
-- execution uses goal_crm_scope_allows with its explicit saved bindings.
CREATE OR REPLACE FUNCTION goal_crm_scope_visible(goal_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT goal_crm_scope_allows(goal_id,nullif(current_setting('app.current_user_id',true),'')::uuid)
 AND NOT EXISTS (SELECT 1 FROM goal_task_source_authority s JOIN tasks t ON t.id=s.task_id
   WHERE s.goal_id=goal_crm_scope_visible.goal_id AND NOT context_scope_allows_current_principal(t.workspace_id,t.sensitivity,t.compartments,t.project_ids))
$$;
COMMIT;
