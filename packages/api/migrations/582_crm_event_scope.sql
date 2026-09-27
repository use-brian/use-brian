BEGIN;

ALTER TABLE crm_domain_event_outbox
  ADD COLUMN scope_source jsonb CHECK(scope_source IS NULL OR jsonb_typeof(scope_source)='object'),
  ADD COLUMN scope_origin text NOT NULL DEFAULT 'legacy' CHECK(scope_origin IN('legacy','captured','unresolved')),
  ADD COLUMN scope_held boolean NOT NULL DEFAULT false;

-- Never derive authority from caller-controlled event payload keys.
CREATE FUNCTION crm_event_entity_source(w uuid,k text,i uuid,lock_source boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tab text; col text; result uuid;
BEGIN
  CASE k
    WHEN 'contact','deal' THEN tab='entities';col='id';
    WHEN 'submission' THEN tab='association_enquiries';col='contact_id';
    WHEN 'entitlement' THEN tab='association_memberships';col='contact_id';
    WHEN 'participation' THEN tab='association_registrations';col='attendee_contact_id';
    ELSE RETURN NULL;
  END CASE;
  EXECUTE format('SELECT %I FROM %I WHERE workspace_id=$1 AND id=$2%s%s',col,tab,
    CASE k WHEN 'contact' THEN ' AND kind=''person''' WHEN 'deal' THEN ' AND kind=''deal''' ELSE '' END,
    CASE WHEN lock_source THEN ' FOR SHARE' ELSE '' END)
    INTO result USING w,i;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION crm_event_entity_source(uuid,text,uuid,boolean) FROM PUBLIC;

UPDATE crm_domain_event_outbox e SET scope_source=read_scope_source(e.workspace_id,'entity',crm_event_entity_source(e.workspace_id,e.subject_kind,e.subject_id)) WHERE status<>'retired';
ALTER TABLE crm_domain_event_outbox ALTER COLUMN scope_origin SET DEFAULT 'unresolved';

CREATE FUNCTION guard_crm_event_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND OLD.status<>'retired' AND NEW.status='retired'
    AND NEW.subject_id='00000000-0000-0000-0000-000000000000'::uuid
    AND NEW.payload=jsonb_build_object('erased',true,'eventType',OLD.event_type)
    AND ROW(NEW.id,NEW.workspace_id,NEW.subject_kind,NEW.event_type)
      IS NOT DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.subject_kind,OLD.event_type) THEN
    -- Canonical privacy retirement is terminal and cannot release content.
    NEW.scope_source=NULL; NEW.scope_origin=OLD.scope_origin; NEW.scope_held=true;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    source_id=crm_event_entity_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id,true);
    NEW.scope_source=read_scope_source(NEW.workspace_id,'entity',source_id);
    NEW.scope_origin=CASE WHEN NEW.scope_source IS NOT NULL AND NOT(NEW.payload ?| ARRAY['batchId','batchCount']) THEN 'captured' ELSE 'unresolved' END;
    NEW.scope_held=false;
  ELSIF ROW(NEW.id,NEW.workspace_id,NEW.subject_kind,NEW.subject_id,NEW.event_type,NEW.scope_source,NEW.scope_origin)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.subject_kind,OLD.subject_id,OLD.event_type,OLD.scope_source,OLD.scope_origin)
    OR (OLD.scope_held AND NOT NEW.scope_held) THEN
    RAISE EXCEPTION 'event_scope_release_required';
  END IF;
  RETURN NEW;
END;
$$;
-- PostgreSQL orders same-kind triggers by name. Privacy admission comes first.
CREATE TRIGGER crm_scope_event_guard BEFORE INSERT OR UPDATE ON crm_domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_crm_event_scope();

-- Internal boolean admission primitive, not a member-readable metadata API.
CREATE FUNCTION crm_scope_snapshot_allows(s jsonb,w uuid,actor uuid,team_grant text[],project_grant uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE member_clearance text; member_teams text[]; teams text[]; projects uuid[];
  agent_clearance text; agent_teams jsonb; agent_projects jsonb;
BEGIN
  IF s IS NULL OR s->>'workspaceId' IS DISTINCT FROM w::text
    OR NOT(s ?& ARRAY['userId','assistantId','sensitivity','compartments','projectIds','held'])
    OR s->>'sensitivity' NOT IN('public','internal','confidential')
    OR s->>'held' IS DISTINCT FROM 'false' OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL
    OR (s->>'userId' IS NOT NULL AND s->>'userId' IS DISTINCT FROM actor::text) THEN RETURN false; END IF;
  SELECT clearance INTO member_clearance FROM workspace_members WHERE workspace_id=w AND user_id=actor;
  IF member_clearance IS NULL OR sensitivity_rank(s->>'sensitivity')>sensitivity_rank(member_clearance) THEN RETURN false; END IF;
  IF nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
    AND current_setting('app.current_user_id',true)<>actor::text THEN RETURN false; END IF;
  teams=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
  projects=ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid);
  member_teams=effective_member_team_compartments(actor,w);
  IF (member_teams IS NOT NULL AND NOT teams <@ member_teams)
    OR (team_grant IS NOT NULL AND NOT teams <@ team_grant)
    OR (project_grant IS NOT NULL AND NOT projects <@ project_grant) THEN RETURN false; END IF;
  IF nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
    AND current_setting('app.agent_actor_id',true)<>actor::text THEN RETURN false; END IF;
  IF NOT agent_visibility_allows(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid) THEN RETURN false; END IF;
  agent_clearance=nullif(current_setting('app.agent_clearance',true),'');
  agent_teams=nullif(current_setting('app.agent_compartments',true),'')::jsonb;
  agent_projects=nullif(current_setting('app.agent_project_ids',true),'')::jsonb;
  RETURN (agent_clearance IS NULL OR sensitivity_rank(s->>'sensitivity')<=sensitivity_rank(agent_clearance))
    AND (agent_teams IS NULL OR agent_teams='null'::jsonb OR agent_teams @> to_jsonb(teams))
    AND (agent_projects IS NULL OR agent_projects='null'::jsonb OR agent_projects @> to_jsonb(projects));
END;
$$;
REVOKE ALL ON FUNCTION crm_scope_snapshot_allows(jsonb,uuid,uuid,text[],uuid[]) FROM PUBLIC;

CREATE FUNCTION crm_event_scope_allows(event_id uuid,actor uuid,team_grant text[] DEFAULT NULL,project_grant uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev crm_domain_event_outbox; live entities; live_scope jsonb; strict_mode boolean;
BEGIN
  SELECT * INTO ev FROM crm_domain_event_outbox WHERE id=event_id;
  IF ev.id IS NULL OR ev.scope_held OR ev.status='retired' OR NOT EXISTS(
    SELECT 1 FROM workspace_members WHERE workspace_id=ev.workspace_id AND user_id=actor) THEN RETURN false; END IF;
  IF (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL AND current_setting('app.current_user_id',true)<>actor::text)
    OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text)
    OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>ev.workspace_id::text) THEN RETURN false; END IF;
  SELECT classification_mode='strict' INTO strict_mode FROM workspace_access_policies WHERE workspace_id=ev.workspace_id;
  IF coalesce(strict_mode,false) AND ev.scope_origin<>'captured' THEN RETURN false; END IF;
  IF ev.scope_source IS NULL THEN RETURN NOT coalesce(strict_mode,false); END IF;
  IF crm_event_entity_source(ev.workspace_id,ev.subject_kind,ev.subject_id) IS DISTINCT FROM (ev.scope_source->>'resourceId')::uuid THEN RETURN false; END IF;
  SELECT * INTO live FROM entities WHERE workspace_id=ev.workspace_id AND id=(ev.scope_source->>'resourceId')::uuid;
  IF live.id IS NULL THEN RETURN false; END IF;
  live_scope=jsonb_build_object('workspaceId',live.workspace_id,'userId',live.user_id,'assistantId',live.assistant_id,
    'sensitivity',live.sensitivity,'compartments',live.compartments,'projectIds',live.project_ids,
    'held',live.scope_held,'validTo',live.valid_to,'retractedAt',live.retracted_at);
  RETURN coalesce(crm_scope_snapshot_allows(ev.scope_source,ev.workspace_id,actor,team_grant,project_grant)
    AND crm_scope_snapshot_allows(live_scope,ev.workspace_id,actor,team_grant,project_grant),false);
END;
$$;
REVOKE ALL ON FUNCTION crm_event_scope_allows(uuid,uuid,text[],uuid[]) FROM PUBLIC;

CREATE FUNCTION crm_event_scope_visible(event_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT crm_event_scope_allows(event_id,nullif(current_setting('app.current_user_id',true),'')::uuid)
 OR EXISTS(SELECT 1 FROM crm_domain_event_outbox e JOIN workspace_members m ON m.workspace_id=e.workspace_id
   AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')
   WHERE e.id=event_id AND e.status='retired' AND e.scope_source IS NULL
     AND e.subject_id='00000000-0000-0000-0000-000000000000'::uuid
     AND e.payload=jsonb_build_object('erased',true,'eventType',e.event_type)
     AND crm_scope_snapshot_allows(jsonb_build_object('workspaceId',e.workspace_id,'userId',NULL,'assistantId',NULL,
       'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'held',false),e.workspace_id,m.user_id,NULL,NULL))
$$;
CREATE POLICY crm_domain_event_scope_read ON crm_domain_event_outbox AS RESTRICTIVE FOR SELECT
  USING(crm_event_scope_visible(id));

CREATE FUNCTION workflow_crm_scope_allows(run_id uuid,actor uuid,team_grant text[] DEFAULT NULL,project_grant uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE lineage(id) AS (
   SELECT id FROM workflow_runs WHERE id=run_id
   UNION
   SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON s.run_id=l.id
 ) SELECT EXISTS(SELECT 1 FROM workflow_runs r JOIN workspace_members m ON m.workspace_id=r.workspace_id AND m.user_id=actor WHERE r.id=run_id)
 AND NOT EXISTS(SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id
   WHERE r.privacy_erased OR (r.crm_event_id IS NOT NULL AND NOT crm_event_scope_allows(r.crm_event_id,actor,team_grant,project_grant))
     OR (r.crm_event_id IS NULL AND r.trigger_kind='event' AND r.input#>>'{trigger,sourceType}'='crm'))
$$;
REVOKE ALL ON FUNCTION workflow_crm_scope_allows(uuid,uuid,text[],uuid[]) FROM PUBLIC;
CREATE FUNCTION workflow_crm_scope_visible(run_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT workflow_crm_scope_allows(run_id,nullif(current_setting('app.current_user_id',true),'')::uuid)
$$;
CREATE POLICY workflow_runs_crm_scope_read ON workflow_runs AS RESTRICTIVE FOR SELECT USING(workflow_crm_scope_visible(id));
CREATE POLICY workflow_steps_crm_scope_read ON workflow_step_runs AS RESTRICTIVE FOR SELECT USING(workflow_crm_scope_visible(run_id));
CREATE POLICY workflow_copies_crm_scope_read ON workflow_run_copy_sources AS RESTRICTIVE FOR SELECT
  USING(workflow_crm_scope_visible(run_id) AND workflow_crm_scope_visible(source_run_id));

CREATE FUNCTION guard_workflow_event_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; teams text[]; projects uuid[]; target workflow_runs; ev crm_domain_event_outbox;
  selected_team uuid; selected_project uuid; selected_key text;
BEGIN
  IF TG_TABLE_NAME='workflow_runs' THEN
    -- crm_privacy_write_admission has already bound NEW.crm_event_id.
    IF NEW.crm_event_id IS NULL THEN RETURN NEW; END IF;
    SELECT coalesce(NEW.triggered_by,w.created_by),w.context_group_id,w.context_project_id INTO actor,selected_team,selected_project
      FROM workflows w WHERE w.id=NEW.workflow_id AND w.workspace_id=NEW.workspace_id FOR SHARE;
    IF NEW.context_group_id IS DISTINCT FROM selected_team OR NEW.context_project_id IS DISTINCT FROM selected_project THEN
      RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501';
    END IF;
    IF selected_team IS NOT NULL THEN
      SELECT compartment_key INTO selected_key FROM workspace_groups WHERE id=selected_team AND workspace_id=NEW.workspace_id AND kind='team' AND status='active' FOR SHARE;
      IF selected_key IS NULL THEN RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501'; END IF;
    END IF;
    teams=CASE WHEN selected_team IS NULL THEN NULL ELSE ARRAY[selected_key] END;
    projects=CASE WHEN selected_project IS NULL THEN NULL ELSE ARRAY[selected_project] END;
    PERFORM user_id FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor FOR SHARE;
    SELECT * INTO ev FROM crm_domain_event_outbox WHERE id=NEW.crm_event_id AND workspace_id=NEW.workspace_id;
    PERFORM crm_event_entity_source(ev.workspace_id,ev.subject_kind,ev.subject_id,true);
    PERFORM id FROM entities WHERE workspace_id=ev.workspace_id AND id=(ev.scope_source->>'resourceId')::uuid FOR SHARE;
    IF NOT crm_event_scope_allows(NEW.crm_event_id,actor,teams,projects) THEN RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO target FROM workflow_runs WHERE id=NEW.run_id;
    SELECT coalesce(target.triggered_by,w.created_by) INTO actor FROM workflows w WHERE w.id=target.workflow_id AND w.workspace_id=target.workspace_id;
    teams=CASE WHEN target.context_group_id IS NULL THEN NULL ELSE target.context_compartments END;
    projects=CASE WHEN target.context_project_id IS NULL THEN NULL ELSE target.context_project_ids END;
    IF NOT workflow_crm_scope_allows(NEW.source_run_id,actor,teams,projects) THEN RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_event_scope_guard BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_workflow_event_scope();
CREATE TRIGGER workflow_event_scope_guard BEFORE INSERT ON workflow_run_copy_sources FOR EACH ROW EXECUTE FUNCTION guard_workflow_event_scope();

COMMIT;
