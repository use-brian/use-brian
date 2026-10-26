BEGIN;
-- [COMP:api/application-persistence] Preserve the reviewed Memory pin set across the feedback-only dispatcher.
DO $reconcile_memory_statement_guard$
DECLARE guard pg_proc; dispatcher pg_proc; previous pg_proc; source_dispatcher pg_proc; canonical_owner oid;
 old_pins text; next_pins text; definition text; expected_oids oid[]; actual_oids oid[];
 pin record; matched integer:=0; normalized jsonb; actual_acl text[];
BEGIN
 SELECT * INTO guard FROM pg_proc WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT proowner INTO canonical_owner FROM pg_proc WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure;
 SELECT * INTO previous FROM pg_proc WHERE oid='public.application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure;
 SELECT * INTO dispatcher FROM pg_proc WHERE oid='public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure;
 SELECT * INTO source_dispatcher FROM pg_proc WHERE oid='public.read_entity_derivation_source(uuid,text,uuid)'::regprocedure;
 IF source_dispatcher.prosrc IS DISTINCT FROM $reviewed_feedback_source$
DECLARE actor uuid;
 root jsonb;parent jsonb;context jsonb;policy jsonb;mask jsonb;feedback_message_id uuid;feedback_session_id uuid;expected text;
BEGIN
 IF k='feedback_event' THEN
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
   OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
   OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text
   OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.analytics_events'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
  root:=read_scope_source(w,k,i);
  IF root IS NULL OR root->>'userId' IS DISTINCT FROM actor::text OR root->>'held' IS DISTINCT FROM 'false'
   OR root->>'version' IS NULL OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL
   OR entity_derivation_envelope_valid(root) IS NOT TRUE OR scope_review_state_held(k,i)
   OR agent_visibility_allows(w,(root->>'userId')::uuid,(root->>'assistantId')::uuid) IS NOT TRUE
   OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
  -- This is only canonical source metadata. The existing negative-only source
  -- identity, exact own-user floor and full current field masks remain mandatory.
  context:=application_feedback_query_context(w);
  IF context IS NULL OR NOT coalesce(to_jsonb(application_feedback_field_keys())<@(context->'read'),false) THEN RETURN NULL;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   IF policy->>'held' IS DISTINCT FROM 'false' OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM root->>'version' THEN RETURN NULL;END IF;
   mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text,root->>'version');
   IF mask IS NULL OR NOT coalesce(to_jsonb(application_feedback_field_keys())<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
  END IF;
  SELECT (a.metadata->>'messageId')::uuid,a.session_id INTO feedback_message_id,feedback_session_id FROM analytics_events a
   WHERE a.workspace_id=w AND a.id=i AND a.user_id=actor AND a.scope_version::text=root->>'version';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM session_messages sm WHERE sm.workspace_id=w AND sm.id=feedback_message_id
   AND sm.session_id=feedback_session_id AND sm.assistant_id=(root->>'assistantId')::uuid) THEN RETURN NULL;END IF;
  SELECT s.source_version INTO expected FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   WHERE d.workspace_id=w AND d.resource_kind='feedback_event' AND d.resource_id=i AND d.resource_version=root->>'version'
    AND s.source_kind='session_message' AND s.source_id=feedback_message_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  parent:=read_entity_derivation_source(w,'session_message',feedback_message_id);
  IF parent IS NULL OR parent->>'held' IS DISTINCT FROM 'false' OR parent->>'version' IS DISTINCT FROM expected
   OR application_session_query_parent(w,feedback_session_id) IS NULL THEN RETURN NULL;END IF;
  RETURN root||jsonb_build_object('requiredSources',coalesce(parent->'requiredSources','[]'::jsonb));
 END IF;
 -- Byte-identical current Memory retirement,8105external-source and fallback branches.
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $reviewed_feedback_source$ THEN
  RAISE EXCEPTION 'Memory statement source dispatcher changed';END IF;
 -- An amendment accepts exactly the original 120-entry guard grammar. Its pins
 -- are retained verbatim; no unknown routine is blessed from its current state.
 -- Reconstruct the complete canonical text from bounded individual pins. This
 -- rejects unmatched text without a large repeated whole-body regular expression.
 SELECT string_agg(format('(%s::oid,%L::text)',m[1]::oid,m[2]),',' ORDER BY ordinal),count(*) INTO old_pins,matched
 FROM regexp_matches(guard.prosrc,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') WITH ORDINALITY AS captures(m,ordinal);
 IF matched<>120 OR guard.prosrc IS DISTINCT FROM
 $prefix$ SELECT count(*)=120 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false) FROM (VALUES $prefix$||old_pins||$suffix$) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid $suffix$
  OR guard.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR guard.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
  OR guard.prosecdef IS DISTINCT FROM true OR guard.provolatile<>'v' OR guard.proisstrict OR guard.proparallel<>'u' OR guard.proowner<>canonical_owner THEN
  RAISE EXCEPTION 'Memory statement guard prerequisite changed';END IF;
 SELECT array_agg(CASE WHEN a.grantee=guard.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END ORDER BY a.grantee)
 INTO actual_acl FROM aclexplode(coalesce(guard.proacl,acldefault('f',guard.proowner))) a
 WHERE a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantor=guard.proowner;
 IF actual_acl IS DISTINCT FROM ARRAY['owner']::text[] OR EXISTS(SELECT 1 FROM aclexplode(coalesce(guard.proacl,acldefault('f',guard.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>guard.proowner) THEN
  RAISE EXCEPTION 'Memory statement guard privileges changed';END IF;
 expected_oids:=ARRAY['public.agent_read_scope_allows(text,text[],uuid[])'::regprocedure::oid,'public.agent_scope_grant_allows(text,text[])'::regprocedure::oid,'public.agent_visibility_allows(uuid,uuid,uuid)'::regprocedure::oid,'public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure::oid,'public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure::oid,'public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_field_digest(jsonb)'::regprocedure::oid,'public.application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_resource_uuid(text)'::regprocedure::oid,'public.application_memory_field_keys()'::regprocedure::oid,'public.application_memory_field_state(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure::oid,'public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_memory_query_context(uuid)'::regprocedure::oid,'public.application_memory_query_domain_state(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_statement_domain(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)'::regprocedure::oid,'public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)'::regprocedure::oid,'public.application_memory_statement_state(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_native_catalog_port_valid(regprocedure)'::regprocedure::oid,'public.application_native_field_catalog_for(uuid,jsonb,text)'::regprocedure::oid,'public.application_native_field_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure::oid,'public.application_native_field_contract_for(uuid,jsonb,text,text)'::regprocedure::oid,'public.application_native_field_rule_allows(jsonb,text[])'::regprocedure::oid,'public.application_native_member_field_permissions(uuid,jsonb,uuid)'::regprocedure::oid,'public.application_native_query_bounds(uuid)'::regprocedure::oid,'public.application_native_record_port_valid(regprocedure)'::regprocedure::oid,'public.application_native_same_destination(uuid,text,uuid,text,uuid)'::regprocedure::oid,'public.application_normalize_native_query_bounds(jsonb)'::regprocedure::oid,'public.application_principal_query_bounds(uuid,uuid,boolean)'::regprocedure::oid,'public.application_query_scope_cap(integer,jsonb,jsonb)'::regprocedure::oid,'public.application_query_scope_intersection(jsonb,jsonb)'::regprocedure::oid,'public.application_query_scope_valid(jsonb)'::regprocedure::oid,'public.application_query_set_intersection(jsonb,jsonb)'::regprocedure::oid,'public.application_reader_envelope_visible(uuid,jsonb)'::regprocedure::oid,'public.application_recorded_field_root_capture(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)'::regprocedure::oid,'public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure::oid,'public.application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure::oid,'public.application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure::oid,'public.assistant_placement_visible(uuid,uuid)'::regprocedure::oid,'public.department_principal_grant_snapshot(uuid)'::regprocedure::oid,'public.department_read_grants()'::regprocedure::oid,'public.department_read_grants_for(uuid)'::regprocedure::oid,'public.department_row_allows(jsonb,uuid,text,text[],uuid)'::regprocedure::oid,'public.effective_member_read_compartments(uuid,uuid)'::regprocedure::oid,'public.effective_member_team_compartments(uuid,uuid)'::regprocedure::oid,'public.entity_derivation_envelope_valid(jsonb)'::regprocedure::oid,'public.knowledge_version_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.legacy_assistant_team_compartments(uuid)'::regprocedure::oid,'public.member_operation_grants(boolean,uuid)'::regprocedure::oid,'public.member_operation_row_allows(jsonb,uuid,text,text[])'::regprocedure::oid,'public.member_operation_scope_allows(uuid,text,text[],boolean)'::regprocedure::oid,'public.member_principal_operation_grants(uuid,boolean,uuid)'::regprocedure::oid,'public.project_member_live(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_application_fields(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_blueprint(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_capture(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_conversation(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_memory_successor(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_recordings(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.read_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_media_parent_snapshot(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_blueprint(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_conversation(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure::oid,'public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_resource_page_dependencies(uuid,text,uuid,text)'::regprocedure::oid,'public.read_scope_source(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_application_fields(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_external(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_knowledge_binding(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_routines(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.scope_review_state_held(text,uuid)'::regprocedure::oid,'public.scope_source_ancestors(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_table(text)'::regprocedure::oid,'public.scope_source_table_before_knowledge_versions(text)'::regprocedure::oid,'public.scope_source_table_before_media(text)'::regprocedure::oid,'public.scope_source_table_before_persistent_context(text)'::regprocedure::oid,'public.sensitivity_rank(text)'::regprocedure::oid,'public.workflow_evidence_envelope_visible(uuid,jsonb)'::regprocedure::oid];
 matched:=0;
 SELECT array_agg(i ORDER BY i) INTO expected_oids FROM unnest(expected_oids) i;
 FOR pin IN SELECT m[1]::oid AS function_oid,m[2] AS fingerprint FROM regexp_matches(guard.prosrc,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') m LOOP
  matched:=matched+1;actual_oids:=array_append(actual_oids,pin.function_oid);
  SELECT to_jsonb(p) INTO normalized FROM pg_proc p WHERE p.oid=pin.function_oid;
  IF pin.function_oid=previous.oid THEN normalized:=normalized||jsonb_build_object('proname','application_field_projection_state');END IF;
  IF pin.function_oid=source_dispatcher.oid THEN normalized:=normalized||jsonb_build_object('prosrc',$original_source$
BEGIN
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $original_source$);END IF;
  IF normalized IS NULL OR encode(sha256(convert_to(normalized::text,'UTF8')),'hex') IS DISTINCT FROM pin.fingerprint THEN
   RAISE EXCEPTION 'Memory statement canonical prerequisite changed: %',pin.function_oid;END IF;
 END LOOP;
 SELECT array_agg(i ORDER BY i) INTO actual_oids FROM unnest(actual_oids) i;
 IF matched<>120 OR actual_oids IS DISTINCT FROM expected_oids OR previous.oid=dispatcher.oid THEN
  RAISE EXCEPTION 'Memory statement canonical identities changed';END IF;
 -- The sole new dispatcher handles feedback_event and delegates all other
 -- inputs, including every Memory input, unchanged to the original routine.
 IF dispatcher.prosrc IS DISTINCT FROM $reviewed$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='feedback_event' THEN
  IF p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
  IF p_selection='query_domain' THEN RETURN application_feedback_outcome_domain_state(w,p_id,p_fields);END IF;
  IF p_selection NOT IN('read','query','identity') THEN RETURN NULL;END IF;
  RETURN application_feedback_field_state(w,p_id,p_fields);
 END IF;
 RETURN application_field_projection_state_before_feedback_outcome(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $reviewed$
  OR dispatcher.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR dispatcher.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR dispatcher.prosecdef IS DISTINCT FROM true OR dispatcher.provolatile<>'v' OR dispatcher.proisstrict OR dispatcher.proparallel<>'u'
  OR dispatcher.proowner<>canonical_owner OR dispatcher.prorettype<>'jsonb'::regtype OR dispatcher.proretset OR dispatcher.prokind<>'f'
  OR dispatcher.proargnames IS DISTINCT FROM ARRAY['w','p_origin','p_type','p_id','p_selection','p_selected_version','p_fields']::text[]
  OR dispatcher.pronamespace<>'public'::regnamespace OR dispatcher.proname<>'application_field_projection_state'
  OR dispatcher.prosupport<>0 OR dispatcher.procost<>100 OR dispatcher.prorows<>0 OR dispatcher.proleakproof
  OR dispatcher.pronargs<>7 OR dispatcher.pronargdefaults<>0 OR dispatcher.provariadic<>0
  OR dispatcher.proallargtypes IS NOT NULL OR dispatcher.proargmodes IS NOT NULL OR dispatcher.proargdefaults IS NOT NULL
  OR dispatcher.protrftypes IS NOT NULL OR dispatcher.probin IS NOT NULL OR dispatcher.prosqlbody IS NOT NULL
  OR dispatcher.proacl IS DISTINCT FROM previous.proacl THEN
  RAISE EXCEPTION 'Memory statement feedback dispatcher changed';END IF;
 old_pins:=substring(guard.prosrc FROM ' FROM \(VALUES (.*)\) pin\(function_oid,fingerprint\) JOIN ');
 IF old_pins IS NULL THEN RAISE EXCEPTION 'Memory statement pin extraction failed';END IF;
 next_pins:=old_pins||format(',(%s::oid,%L::text)',dispatcher.oid,encode(sha256(convert_to(to_jsonb(dispatcher)::text,'UTF8')),'hex'));
 definition:=format($definition$CREATE OR REPLACE FUNCTION public.application_memory_statement_helpers_current() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guard$ SELECT count(*)=121 AND coalesce(bool_and(coalesce((p.oid<>%s::oid OR p.proname='application_field_projection_state_before_feedback_outcome') AND (p.oid<>%s::oid OR p.prosrc=%L) AND encode(sha256(convert_to((CASE WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('proname','application_field_projection_state') WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('prosrc',%L) ELSE to_jsonb(p) END)::text,'UTF8')),'hex')=pin.fingerprint,false)),false) FROM (VALUES %s) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid $guard$$definition$,
  previous.oid,source_dispatcher.oid,source_dispatcher.prosrc,previous.oid,source_dispatcher.oid,$original_source$
BEGIN
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $original_source$,next_pins);
 EXECUTE definition;
END $reconcile_memory_statement_guard$;
COMMIT;
