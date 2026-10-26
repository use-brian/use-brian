-- Spec: docs/architecture/features/goals.md -> Retained Task producer authority
-- [COMP:api/task-responsibility] Same-transaction retained Task-to-Goal binding.
BEGIN;
CREATE FUNCTION retained_task_goal_source_current(tid uuid,retaining boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE saved goal_task_source_authority;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 source jsonb;current jsonb;origin jsonb;w uuid;
BEGIN
 SELECT * INTO saved FROM goal_task_source_authority WHERE task_id=tid;
 IF NOT FOUND OR saved.proof->'retained' IS NULL THEN RETURN false;END IF;
 w:=saved.workspace_id;origin:=saved.proof->'retained'->'sourceAuthority';
 IF actor IS NULL OR actor::text IS DISTINCT FROM saved.proof->>'userId'
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS DISTINCT FROM saved.proof->>'assistantId'
  OR nullif(current_setting('app.retained_task_goal',true),'') IS DISTINCT FROM tid::text
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS DISTINCT FROM actor::text
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR origin->>'visibility' IS DISTINCT FROM 'personal'
  OR origin->>'kind' IS DISTINCT FROM 'session' OR origin->>'authorityUserId' IS DISTINCT FROM actor::text
  OR origin->>'executingAssistantId' IS DISTINCT FROM saved.proof->>'assistantId'
  OR origin->>'workspaceId' IS DISTINCT FROM w::text OR origin->>'systemRead' IS DISTINCT FROM 'false'
  OR origin->>'ignoreSessionBinding' IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.goals'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=(origin->>'id')::uuid AND s.workspace_id=w
    AND s.user_id=(origin->>'userId')::uuid AND s.assistant_id=(origin->>'assistantId')::uuid
    AND s.context_group_id IS NOT DISTINCT FROM (origin->>'contextGroupId')::uuid
    AND s.context_project_id IS NOT DISTINCT FROM (origin->>'contextProjectId')::uuid
    AND date_trunc('milliseconds',s.context_locked_at)=(origin->>'contextLockedAt')::timestamptz AND s.visibility='personal' AND s.mode IS NULL
    AND s.context_binding_origin<>'held' AND s.effective_clearance IS NOT DISTINCT FROM origin->>'effectiveClearance'
    AND coalesce(to_jsonb(s.context_compartments),'[]'::jsonb) @> (origin->'contextCompartments')
    AND (origin->'contextCompartments') @> coalesce(to_jsonb(s.context_compartments),'[]'::jsonb))
  OR NOT EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=w AND t.id=tid
    AND t.scope_version::text=saved.proof->'retained'->>'version' AND NOT t.scope_held
    AND t.valid_to IS NULL AND t.retracted_at IS NULL AND t.user_id IS NULL AND t.assistant_id IS NULL
    AND t.parent_id IS NULL)
  OR jsonb_typeof(saved.proof->'retained'->'sources') IS DISTINCT FROM 'array'
  OR jsonb_array_length(saved.proof->'retained'->'sources') NOT BETWEEN 1 AND 1000 THEN RETURN false;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(saved.proof->'retained'->'sources') LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN false;END IF;
  current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
    OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
    OR (current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity')
      IS DISTINCT FROM(source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
    OR NOT (current->'compartments') @> (source->'compartments') OR NOT (source->'compartments') @> (current->'compartments')
    OR NOT (current->'projectIds') @> (source->'projectIds') OR NOT (source->'projectIds') @> (current->'projectIds')
    OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN false;END IF;
  IF retaining AND source->>'resourceKind'='external_source'
    AND external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 RETURN EXISTS(SELECT 1 FROM tasks t WHERE t.id=tid AND t.workspace_id=w
   AND jsonb_build_object('title',t.title,'attributes',t.attributes)=(saved.proof->>'snapshot')::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION retained_task_goal_source_current(uuid,boolean) FROM PUBLIC;
CREATE FUNCTION bind_retained_task_goal_source(tid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE saved goal_task_source_authority;g goals;
BEGIN
 SELECT * INTO saved FROM goal_task_source_authority WHERE task_id=tid FOR UPDATE;
 IF NOT FOUND OR saved.goal_id IS NOT NULL OR retained_task_goal_source_current(tid,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'goal_source_unsupported' USING ERRCODE='42501';END IF;
 SELECT * INTO g FROM goals WHERE id=gid AND xmin::text::bigint=(pg_current_xact_id()::text::numeric%4294967296)::bigint FOR UPDATE;
 IF NOT FOUND OR g.workspace_id<>saved.workspace_id OR g.created_by_user_id::text IS DISTINCT FROM saved.proof->>'userId'
   OR g.host_type IS DISTINCT FROM 'task' OR g.host_id IS DISTINCT FROM tid
   OR g.parent_goal_id IS NOT NULL OR g.recipe_id IS NOT NULL OR g.origin_session_id IS NOT NULL OR g.confirmed_at IS NOT NULL
   OR g.authoring_authority IS DISTINCT FROM saved.proof->'authority'
   OR g.context_group_id IS DISTINCT FROM (saved.proof->>'contextGroupId')::uuid
   OR g.context_project_id IS DISTINCT FROM (saved.proof->>'contextProjectId')::uuid THEN
  RAISE EXCEPTION 'goal_source_unsupported' USING ERRCODE='42501';END IF;
 UPDATE goal_task_source_authority SET goal_id=gid WHERE task_id=tid;
END $$;
REVOKE ALL ON FUNCTION bind_retained_task_goal_source(uuid,uuid) FROM PUBLIC;
DO $$ DECLARE definition text;renamed text;BEGIN
 definition:=pg_get_functiondef('public.goal_task_scope_allows(uuid,uuid,text[],uuid[])'::regprocedure);
 renamed:=replace(definition,'FUNCTION public.goal_task_scope_allows(', 'FUNCTION public.goal_task_scope_allows_before_retained(');
 IF renamed=definition OR position('FUNCTION public.goal_task_scope_allows_before_retained(' IN renamed)=0 THEN
  RAISE EXCEPTION 'goal_source_function_definition_unavailable';END IF;
 EXECUTE renamed;
END $$;
REVOKE ALL ON FUNCTION goal_task_scope_allows_before_retained(uuid,uuid,text[],uuid[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION goal_task_scope_allows(gid uuid,actor uuid,teams text[] DEFAULT NULL,projects uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM goal_task_source_authority s WHERE s.goal_id=gid AND s.proof->'retained' IS NOT NULL)
  THEN EXISTS(SELECT 1 FROM goal_task_source_authority s WHERE s.goal_id=gid AND s.proof->>'userId'=actor::text
    AND retained_task_goal_source_current(s.task_id,false))
  WHEN EXISTS(SELECT 1 FROM goals g JOIN tasks t ON t.id=g.host_id AND t.workspace_id=g.workspace_id
    WHERE g.id=gid AND g.host_type='task' AND (
      EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=t.workspace_id AND d.resource_kind='task' AND d.resource_id IN(t.id,t.logical_id))
      OR EXISTS(SELECT 1 FROM application_scope_lineage(t.workspace_id,ARRAY['task'],ARRAY[t.id],ARRAY[t.scope_version::text]) node
        WHERE node.kind IN('external_source','application_field','session_context_revision','page_event_changed','page_event_destination','page_live_changed','page_live_destination')))) THEN false
  ELSE goal_task_scope_allows_before_retained(gid,actor,teams,projects) END
$$;
REVOKE ALL ON FUNCTION goal_task_scope_allows(uuid,uuid,text[],uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION bind_retained_task_goal_source(uuid,uuid) TO app_user;
END IF;END $$;
COMMIT;
