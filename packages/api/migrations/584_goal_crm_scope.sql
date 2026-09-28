BEGIN;

-- Event IDs deliberately have no cascading FK: deletion must withhold a goal,
-- never remove its causal audience. Receipts outlive goals while run copies remain.
CREATE TABLE goal_crm_event_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_binding jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(goal_id,event_id)
);
CREATE INDEX goal_crm_event_sources_workspace ON goal_crm_event_sources(workspace_id);
ALTER TABLE goal_crm_event_sources ENABLE ROW LEVEL SECURITY;
-- Internal source receipts have no member-readable or member-writable policy.
ALTER TABLE workflow_runs ADD COLUMN source_goal_id uuid;
CREATE INDEX workflow_runs_source_goal ON workflow_runs(source_goal_id) WHERE source_goal_id IS NOT NULL;
UPDATE workflow_runs r SET source_goal_id=g.id FROM goals g
  WHERE r.workspace_id=g.workspace_id AND r.input->>'goalId'=g.id::text
    AND g.means->>'workflowId'=r.workflow_id::text
    AND r.triggered_by=g.created_by_user_id;

-- Even identical subscriptions/state are a new park generation. A stale
-- dispatcher cannot consume it by presenting an old structurally equal marker.
CREATE FUNCTION stamp_goal_event_park() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.awaiting_event IS NOT NULL THEN
    NEW.awaiting_event=jsonb_set(NEW.awaiting_event,'{revision}',to_jsonb(gen_random_uuid()::text),true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER goal_event_park_revision BEFORE INSERT OR UPDATE OF awaiting_event ON goals
  FOR EACH ROW EXECUTE FUNCTION stamp_goal_event_park();
UPDATE goals SET awaiting_event=awaiting_event WHERE awaiting_event IS NOT NULL;

CREATE FUNCTION goal_crm_event_binding(e crm_domain_event_outbox) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('workspaceId',e.workspace_id,'subjectKind',e.subject_kind,'subjectId',e.subject_id,
   'eventType',e.event_type,'createdAtMicros',(extract(epoch FROM e.created_at)*1000000)::numeric,'source',e.scope_source,'origin',e.scope_origin)
$$;
REVOKE ALL ON FUNCTION goal_crm_event_binding(crm_domain_event_outbox) FROM PUBLIC;

CREATE FUNCTION goal_crm_scope_allows(goal_id uuid,actor uuid,team_grant text[] DEFAULT NULL,project_grant uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM goals g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=actor WHERE g.id=goal_id)
 AND NOT EXISTS(SELECT 1 FROM goal_crm_event_sources s JOIN goals g ON g.id=s.goal_id
   LEFT JOIN crm_domain_event_outbox e ON e.id=s.event_id
   WHERE s.goal_id=goal_crm_scope_allows.goal_id AND (s.workspace_id<>g.workspace_id OR e.id IS NULL
     OR s.event_binding IS DISTINCT FROM goal_crm_event_binding(e)
     OR NOT crm_event_scope_allows(s.event_id,actor,team_grant,project_grant)))
$$;
REVOKE ALL ON FUNCTION goal_crm_scope_allows(uuid,uuid,text[],uuid[]) FROM PUBLIC;
CREATE FUNCTION goal_crm_scope_visible(goal_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT goal_crm_scope_allows(goal_id,nullif(current_setting('app.current_user_id',true),'')::uuid)
$$;
CREATE POLICY goals_crm_source_read ON goals AS RESTRICTIVE FOR SELECT USING(goal_crm_scope_visible(id));

CREATE FUNCTION goal_crm_execution_allows(gid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g goals; selected_key text;
BEGIN
  SELECT * INTO g FROM goals WHERE id=gid;
  IF g.id IS NULL OR g.created_by_user_id IS NULL THEN RETURN false; END IF;
  IF g.context_group_id IS NOT NULL THEN
    SELECT compartment_key INTO selected_key FROM workspace_groups WHERE id=g.context_group_id AND workspace_id=g.workspace_id AND kind='team' AND status='active';
    IF selected_key IS NULL THEN RETURN false; END IF;
  END IF;
  IF g.context_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_projects
    WHERE id=g.context_project_id AND workspace_id=g.workspace_id AND status='active') THEN RETURN false; END IF;
  RETURN goal_crm_scope_allows(g.id,g.created_by_user_id,
    CASE WHEN g.context_group_id IS NULL THEN NULL ELSE ARRAY[selected_key] END,
    CASE WHEN g.context_project_id IS NULL THEN NULL ELSE ARRAY[g.context_project_id] END);
END;
$$;
REVOKE ALL ON FUNCTION goal_crm_execution_allows(uuid) FROM PUBLIC;

CREATE FUNCTION guard_goal_crm_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g goals; ev crm_domain_event_outbox; selected_key text; teams text[]; projects uuid[];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.event_binding='{"erased":true}'::jsonb AND (to_jsonb(NEW)-'event_binding') IS NOT DISTINCT FROM (to_jsonb(OLD)-'event_binding')
      AND EXISTS(SELECT 1 FROM crm_domain_event_outbox e WHERE e.id=OLD.event_id AND e.workspace_id=OLD.workspace_id
        AND e.status='retired' AND e.scope_source IS NULL AND e.subject_id='00000000-0000-0000-0000-000000000000'::uuid) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'goal_source_scope_immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) AND
      (EXISTS(SELECT 1 FROM goals WHERE id=OLD.goal_id) OR EXISTS(SELECT 1 FROM workflow_runs WHERE source_goal_id=OLD.goal_id)) THEN
      RAISE EXCEPTION 'goal_source_scope_immutable'; END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id AND workspace_id=NEW.workspace_id FOR SHARE;
  IF g.id IS NULL OR g.created_by_user_id IS NULL OR g.confirmed_at IS NULL
    OR g.awaiting_event IS NULL OR g.status IN('done','abandoned','blocked') THEN
    RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';
  END IF;
  IF g.context_group_id IS NOT NULL THEN
    SELECT compartment_key INTO selected_key FROM workspace_groups WHERE id=g.context_group_id AND workspace_id=g.workspace_id AND kind='team' AND status='active' FOR SHARE;
    IF selected_key IS NULL THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  teams=CASE WHEN g.context_group_id IS NULL THEN NULL ELSE ARRAY[selected_key] END;
  projects=CASE WHEN g.context_project_id IS NULL THEN NULL ELSE ARRAY[g.context_project_id] END;
  PERFORM user_id FROM workspace_members WHERE workspace_id=g.workspace_id AND user_id=g.created_by_user_id FOR SHARE;
  SELECT * INTO ev FROM crm_domain_event_outbox WHERE id=NEW.event_id AND workspace_id=g.workspace_id;
  IF ev.id IS NULL THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501'; END IF;
  PERFORM crm_event_entity_source(ev.workspace_id,ev.subject_kind,ev.subject_id,true);
  PERFORM id FROM entities WHERE workspace_id=ev.workspace_id AND id=(ev.scope_source->>'resourceId')::uuid FOR SHARE;
  IF NOT goal_crm_execution_allows(g.id)
    OR NOT crm_event_scope_allows(ev.id,g.created_by_user_id,teams,projects) THEN
    RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';
  END IF;
  NEW.event_binding=goal_crm_event_binding(ev);
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON goal_crm_event_sources FOR EACH ROW EXECUTE FUNCTION crm_privacy_guard_write();
CREATE TRIGGER goal_crm_source_guard BEFORE INSERT OR UPDATE OR DELETE ON goal_crm_event_sources FOR EACH ROW EXECUTE FUNCTION guard_goal_crm_source();

CREATE FUNCTION claim_crm_goal_resume(gid uuid,eid uuid,w uuid,expected_marker jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g goals;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||w::text,0)) THEN
    RAISE EXCEPTION 'crm_privacy_operation_busy' USING ERRCODE='55P03';
  END IF;
  SELECT * INTO g FROM goals WHERE id=gid AND workspace_id=w FOR UPDATE;
  IF g.id IS NULL OR g.awaiting_event IS NULL OR g.awaiting_event IS DISTINCT FROM expected_marker
    OR EXISTS(SELECT 1 FROM goal_crm_event_sources WHERE goal_id=gid AND event_id=eid) THEN RETURN false; END IF;
  INSERT INTO goal_crm_event_sources(workspace_id,goal_id,event_id) VALUES(w,gid,eid);
  UPDATE goals SET awaiting_event=NULL WHERE id=gid;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION claim_crm_goal_resume(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION guard_workflow_goal_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g goals; candidate text; actor uuid; selected_team uuid; selected_project uuid; selected_key text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.source_goal_id IS DISTINCT FROM OLD.source_goal_id THEN RAISE EXCEPTION 'goal_source_scope_immutable'; END IF;
    RETURN NEW;
  END IF;
  candidate=NEW.input->>'goalId';
  IF NEW.source_goal_id IS NULL AND candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO g FROM goals WHERE id=candidate::uuid;
    IF g.id IS NOT NULL THEN NEW.source_goal_id=g.id; END IF;
  END IF;
  IF NEW.source_goal_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM goals WHERE id=NEW.source_goal_id AND workspace_id=NEW.workspace_id FOR SHARE;
  actor=NEW.triggered_by;
  SELECT context_group_id,context_project_id INTO selected_team,selected_project FROM workflows
    WHERE id=NEW.workflow_id AND workspace_id=NEW.workspace_id FOR SHARE;
  IF NEW.context_group_id IS DISTINCT FROM selected_team OR NEW.context_project_id IS DISTINCT FROM selected_project THEN
    RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';
  END IF;
  IF selected_team IS NOT NULL THEN
    SELECT compartment_key INTO selected_key FROM workspace_groups WHERE id=selected_team AND workspace_id=NEW.workspace_id AND kind='team' AND status='active' FOR SHARE;
    IF selected_key IS NULL THEN RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF g.id IS NULL OR actor IS DISTINCT FROM g.created_by_user_id OR g.means->>'workflowId' IS DISTINCT FROM NEW.workflow_id::text
    OR NOT goal_crm_execution_allows(g.id)
    OR NOT goal_crm_scope_allows(g.id,actor,CASE WHEN selected_team IS NULL THEN NULL ELSE ARRAY[selected_key] END,
      CASE WHEN selected_project IS NULL THEN NULL ELSE ARRAY[selected_project] END) THEN
    RAISE EXCEPTION 'goal_source_scope_unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_goal_scope_guard BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_workflow_goal_scope();

CREATE OR REPLACE FUNCTION workflow_crm_scope_allows(run_id uuid,actor uuid,team_grant text[] DEFAULT NULL,project_grant uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE lineage(id) AS (
   SELECT id FROM workflow_runs WHERE id=run_id
   UNION
   SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON s.run_id=l.id
 ) SELECT EXISTS(SELECT 1 FROM workflow_runs r JOIN workspace_members m ON m.workspace_id=r.workspace_id AND m.user_id=actor WHERE r.id=run_id)
 AND NOT EXISTS(SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id
   WHERE r.privacy_erased OR (r.crm_event_id IS NOT NULL AND NOT crm_event_scope_allows(r.crm_event_id,actor,team_grant,project_grant))
     OR (r.crm_event_id IS NULL AND r.trigger_kind='event' AND r.input#>>'{trigger,sourceType}'='crm')
     OR (r.source_goal_id IS NOT NULL AND NOT goal_crm_scope_allows(r.source_goal_id,actor,team_grant,project_grant)))
$$;
COMMIT;
