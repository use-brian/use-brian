-- Spec: docs/architecture/features/tasks.md -> Current source ancestry on native task creation
-- [COMP:api/application-persistence] Canonical native Task lineage under original nonowner authority.
BEGIN;
CREATE FUNCTION record_admitted_native_task_derivation(w uuid,i uuid,v text,producer text,sources jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;output tasks;
 source jsonb;current jsonb;output_source jsonb;derivation uuid;dependency record;dependency_count integer:=0;
BEGIN
 IF actor IS NULL OR acting IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 SELECT t.* INTO output FROM tasks t WHERE t.workspace_id=w AND t.id=i AND t.logical_id=t.id AND t.scope_version::text=v
  AND t.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint FOR UPDATE;
 IF NOT FOUND OR output.created_by_user_id IS DISTINCT FROM actor OR output.created_by_assistant_id IS DISTINCT FROM acting OR output.scope_held
  OR output.valid_to IS NOT NULL OR output.retracted_at IS NOT NULL
  OR output.user_id IS NOT NULL AND output.user_id<>actor
  OR output.assistant_id IS NOT NULL AND output.assistant_id IS DISTINCT FROM acting
  OR member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
  OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 output_source:=read_admitted_native_scope_snapshot(w,'task',i);
 IF output_source IS NULL OR output_source->>'held' IS DISTINCT FROM 'false' OR output_source->>'version' IS DISTINCT FROM v
  OR (SELECT count(DISTINCT (s->>'resourceKind',s->>'resourceId')) FROM jsonb_array_elements(sources) s)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
   OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
   OR (current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current->'compartments')
   OR NOT (current->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 END LOOP;
 FOR dependency IN
  SELECT DISTINCT dep.node_version,dep.source FROM generate_series(0,jsonb_array_length(sources)-1,100) chunks(start_at)
  CROSS JOIN LATERAL (SELECT array_agg(root.body->>'resourceKind' ORDER BY root.ord) kinds,
   array_agg((root.body->>'resourceId')::uuid ORDER BY root.ord) ids,array_agg(root.body->>'version' ORDER BY root.ord) versions
   FROM jsonb_array_elements(sources) WITH ORDINALITY root(body,ord) WHERE root.ord>chunks.start_at AND root.ord<=chunks.start_at+100) roots
  CROSS JOIN LATERAL read_external_source_dependencies(w,roots.kinds,roots.ids,roots.versions) dep LIMIT 4097 LOOP
  dependency_count:=dependency_count+1;
  IF dependency_count>4096 OR dependency.source IS NULL OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) provided WHERE provided->>'resourceKind'='external_source'
    AND provided->>'resourceId'=dependency.source->>'resourceId' AND provided->>'version'=dependency.node_version)
   OR external_source_retention_allowed(w,(dependency.source->>'resourceId')::uuid,dependency.node_version) IS NOT TRUE THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'task',i,v,producer,output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids,p.revision
  FROM workspace_access_policies p WHERE p.workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,s->>'resourceKind',(s->>'resourceId')::uuid,s->>'version' FROM jsonb_array_elements(sources) s ORDER BY s->>'resourceKind',s->>'resourceId';
 RETURN derivation;
END $$;
REVOKE ALL ON FUNCTION record_admitted_native_task_derivation(uuid,uuid,text,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION record_admitted_native_task_derivation(uuid,uuid,text,text,jsonb) TO app_user;
END IF;END $$;
-- Native member dedup cannot directly read admin-only lineage tables.
CREATE FUNCTION native_task_derivation_matches(w uuid,i uuid,v text,sources jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;snapshot jsonb;expected jsonb;actual jsonb;
BEGIN
 IF actor IS NULL OR acting IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(sources) source WHERE entity_derivation_envelope_valid(source) IS NOT TRUE
    OR source->>'workspaceId' IS DISTINCT FROM w::text OR source->>'resourceKind' IS NULL
    OR source->>'resourceId' IS NULL OR source->>'version' IS NULL) THEN RETURN false;END IF;
 snapshot:=read_admitted_native_scope_snapshot(w,'task',i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM v
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=w AND t.id=i AND t.scope_version::text=v
    AND NOT t.scope_held AND t.valid_to IS NULL AND t.retracted_at IS NULL) THEN RETURN false;END IF;
 SELECT jsonb_agg(jsonb_build_array(source->>'resourceKind',source->>'resourceId',source->>'version')
  ORDER BY source->>'resourceKind',source->>'resourceId',source->>'version') INTO expected FROM jsonb_array_elements(sources) source;
 IF (SELECT count(DISTINCT(source->>'resourceKind',source->>'resourceId')) FROM jsonb_array_elements(sources) source)<>jsonb_array_length(sources) THEN RETURN false;END IF;
 SELECT jsonb_agg(jsonb_build_array(s.source_kind,s.source_id::text,s.source_version) ORDER BY s.source_kind,s.source_id::text,s.source_version)
  INTO actual FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=i AND d.resource_id IN(t.id,t.logical_id)
  WHERE d.workspace_id=w AND d.resource_kind='task' AND d.resource_version=v;
 RETURN actual IS NOT NULL AND actual=expected;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION native_task_derivation_matches(uuid,uuid,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION native_task_derivation_matches(uuid,uuid,text,jsonb) TO app_user;
END IF;END $$;
-- A native-only duplicate candidate is metadata until full canonical fields are admitted.
CREATE FUNCTION native_task_dedup_candidate_allowed(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;snapshot jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false;END IF;
 -- Existing admitted native metadata independently checks any actual assistant,
 -- private actor, current member/department/project and parent scope.
 snapshot:=read_admitted_native_scope_snapshot(w,'task',i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM v
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL THEN RETURN false;END IF;
 RETURN NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY['task'],ARRAY[i],ARRAY[v]) node
  WHERE node.kind IN('external_source','application_field','session_context_revision','page_event_changed','page_event_destination','page_live_changed','page_live_destination'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION native_task_dedup_candidate_allowed(uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION native_task_dedup_candidate_allowed(uuid,uuid,text) TO app_user;
END IF;END $$;
COMMIT;
