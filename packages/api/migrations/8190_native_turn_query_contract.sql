-- [COMP:api/native-turn-frame] Authenticate the canonical query-helper successor.
BEGIN;
DO $bridge$
DECLARE helper pg_proc;guard pg_proc;roster text;old_fingerprint text;new_fingerprint text;
BEGIN
 SELECT * INTO STRICT guard FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure;
 SELECT string_agg(quote_literal(signature),',' ORDER BY signature) INTO roster
 FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_field_digest(jsonb)','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_query_context(uuid)','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_native_field_rule_allows(jsonb,text[])','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','assistant_placement_visible(uuid,uuid)','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_scope_source(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','scope_review_state_held(text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','sensitivity_rank(text)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) expected(signature);
 IF guard.proowner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR guard.pronamespace<>'public'::regnamespace OR guard.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
  OR (to_jsonb(guard)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM '{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR encode(sha256(convert_to(replace(guard.prosrc,'ARRAY['||roster||']::text[]','__ROSTER__'),'UTF8')),'hex') IS DISTINCT FROM '803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(guard.proacl,acldefault('f',guard.proowner))) a
   WHERE a.grantee<>guard.proowner OR a.grantor<>guard.proowner OR a.is_grantable OR a.privilege_type<>'EXECUTE')
 THEN RAISE EXCEPTION 'native_turn_query_guard_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.native_turn_contract_helpers'::regclass
  AND c.relowner=guard.proowner AND c.relkind='r' AND c.relpersistence='p' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner OR a.grantor<>c.relowner)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND (attacl IS NOT NULL OR attisdropped OR atthasdef OR attgenerated<>'' OR attidentity<>''))
  AND (SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) ORDER BY attnum)
   FROM pg_attribute WHERE attrelid=c.oid AND attnum>0)='[["signature","text",true],["fingerprint","text",true]]'::jsonb
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)
  AND (SELECT count(*) FILTER(WHERE contype='p')=1
   AND bool_and(contype='p' AND conkey=ARRAY[1]::smallint[] OR contype='n' AND conkey IN(ARRAY[1]::smallint[],ARRAY[2]::smallint[]))
   AND coalesce(jsonb_agg(to_jsonb(conkey) ORDER BY conkey) FILTER(WHERE contype='n'),'[]'::jsonb) IN('[]'::jsonb,'[[1],[2]]'::jsonb)
   FROM pg_constraint WHERE conrelid=c.oid))
 THEN RAISE EXCEPTION 'native_turn_query_manifest_changed';END IF;
 SELECT * INTO STRICT helper FROM pg_proc WHERE oid='public.application_query_scope_union_contains(jsonb,jsonb,integer)'::regprocedure;
 IF helper.proowner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR helper.pronamespace<>'public'::regnamespace OR helper.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(helper)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM '{"probin":null,"procost":100,"prokind":"f","proname":"application_query_scope_union_contains","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["original","current_scopes","budget"],"proargtypes":["3802","3802","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR encode(sha256(convert_to(helper.prosrc,'UTF8')),'hex') IS DISTINCT FROM '0826fc789c29348979578f003b58f74d3fa246876f8cde71c9a34c66ee3fb1c6'
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
   WHERE a.grantee<>helper.proowner OR a.grantor<>helper.proowner OR a.is_grantable OR a.privilege_type<>'EXECUTE')
 THEN RAISE EXCEPTION 'native_turn_query_successor_changed';END IF;
 old_fingerprint:=encode(sha256(convert_to((to_jsonb(helper)||jsonb_build_object('prosrc',$canonical$
DECLARE original_scope jsonb:=public.application_normalize_native_query_bounds(original); scope jsonb; normalized jsonb[]:='{}';
 tier int; departments text[]; required_departments text[]; options jsonb; conditions jsonb[]; used int:=1; escaped jsonb;
 original_context text; current_context text; department text; general_covered boolean; department_covered boolean;
BEGIN
 IF budget IS NULL OR budget<1 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
 IF public.application_query_scope_valid(original) IS NOT TRUE OR jsonb_typeof(current_scopes) IS DISTINCT FROM 'array'
  THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
 FOR scope IN SELECT value FROM jsonb_array_elements(current_scopes) LOOP
  used:=used+1;
  IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  scope:=public.application_normalize_native_query_bounds(scope);
  -- These axes are independent upper sets. Coverage of the original maximum
  -- Project/other-label/Project-ID combination covers every subset as well.
  IF (scope->'projectLabels'='null' OR (original_scope->'projectLabels')<@(scope->'projectLabels'))
   AND (scope->'otherLabels'='null' OR original_scope->'otherLabels'<>'null' AND (original_scope->'otherLabels')<@(scope->'otherLabels'))
   AND (scope->'projectIds'='null' OR original_scope->'projectIds'<>'null' AND (original_scope->'projectIds')<@(scope->'projectIds')) THEN
   normalized:=array_append(normalized,scope);
  END IF;
 END LOOP;
 original_context:=original_scope->>'contextDepartment';
 FOR tier IN 1..3 LOOP
  general_covered:=(original_scope->>'tier')::int<tier;
  conditions:='{}';department_covered:=false;required_departments:='{}';
  IF original_scope->'departments'='null' THEN
   IF tier>(original_scope->>'tier')::int THEN departments:='{}';
   ELSE
    -- A fresh Department outside every finite current map witnesses the
    -- legacy universe. Only a current universe can cover that combination.
    departments:=ARRAY['d:*'];required_departments:=departments;
    IF original_context IS NOT NULL THEN departments:=array_append(departments,'d:='||original_context);required_departments:=departments; END IF;
   END IF;
  ELSE
   SELECT coalesce(array_agg('d:='||key ORDER BY key),'{}') INTO departments FROM jsonb_each(original_scope->'departments') WHERE (value#>>'{}')::int>=tier;
   IF original_context IS NOT NULL THEN
    IF NOT ('d:='||original_context=ANY(departments)) THEN departments:='{}';
    ELSE required_departments:=ARRAY['d:='||original_context]; END IF;
   END IF;
  END IF;
  FOREACH scope IN ARRAY normalized LOOP
   used:=used+1;
   IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
   IF tier<=(scope->>'tier')::int THEN general_covered:=true; END IF;
   IF cardinality(departments)=0 OR department_covered THEN CONTINUE; END IF;
   current_context:=scope->>'contextDepartment';
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(departments))
    OR scope->'departments'='null' AND tier>(scope->>'tier')::int THEN CONTINUE; END IF;
   options:='[]';
   FOREACH department IN ARRAY departments LOOP
    IF scope->'departments'<>'null' AND (department='d:*' OR coalesce((scope#>>ARRAY['departments',substr(department,4)])::int,0)<tier) THEN
     options:=options||jsonb_build_array(jsonb_build_object('present',department));
    END IF;
   END LOOP;
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(required_departments)) THEN
    options:=options||jsonb_build_array(jsonb_build_object('absent','d:='||current_context));
   END IF;
   IF jsonb_array_length(options)=0 THEN department_covered:=true;
   ELSE conditions:=array_append(conditions,options); END IF;
  END LOOP;
  IF NOT general_covered THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  IF cardinality(departments)>0 AND NOT department_covered THEN
   escaped:=public.application_query_scope_escape(conditions,1,required_departments,'{}',departments,budget-used);
   used:=used+(escaped->>'used')::int;
   IF escaped->>'escape'='true' THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('contains',true,'used',used);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN jsonb_build_object('contains',false,'used',used);
END $canonical$))::text,'UTF8')),'hex');
 new_fingerprint:=encode(sha256(convert_to(to_jsonb(helper)::text,'UTF8')),'hex');
 UPDATE public.native_turn_contract_helpers SET fingerprint=new_fingerprint
 WHERE signature='application_query_scope_union_contains(jsonb,jsonb,integer)' AND fingerprint=old_fingerprint;
 IF NOT FOUND THEN RAISE EXCEPTION 'native_turn_query_predecessor_pin_changed';END IF;
 IF public.native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_turn_query_reader_contract_changed';END IF;
END $bridge$;
COMMIT;
