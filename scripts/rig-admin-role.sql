-- [COMP:platform/local-rig] Fixed maintained fixture phases, selected by runtime-role.mjs.
-- Not a product migration or arbitrary database repair API. No function grant cloning.
-- phase: prepare
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user') THEN
  IF to_regclass('public._migrations') IS NOT NULL THEN
   IF EXISTS(SELECT FROM public._migrations) THEN RAISE EXCEPTION 'Migrated administrative fixture lacks canonical role; preserve it and use a new fixture port';END IF;
  END IF;
  CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
DO $$ DECLARE empty_chain boolean:=true;BEGIN
 IF to_regclass('public._migrations') IS NOT NULL THEN SELECT NOT EXISTS(SELECT FROM public._migrations) INTO empty_chain;END IF;
 IF empty_chain THEN
  GRANT USAGE ON SCHEMA public TO app_user;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;
 END IF;
END $$;
-- phase: safety
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user') THEN RAISE EXCEPTION 'Canonical role missing before runtime setup';END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('app_user','assurance_app','admin_fixture_app')
  AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolname='app_user' AND rolinherit))
 OR EXISTS(SELECT FROM pg_auth_members WHERE roleid IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','assurance_app','admin_fixture_app'))
  OR member IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','assurance_app','admin_fixture_app')))
 OR EXISTS(SELECT FROM pg_class WHERE relowner IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','assurance_app','admin_fixture_app')))
 OR EXISTS(SELECT FROM pg_proc WHERE proowner IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','assurance_app','admin_fixture_app'))) THEN
  RAISE EXCEPTION 'Fixture runtime role has unsafe privileges, membership or object ownership';END IF;
END $$;

-- Recognize only the existing post8113 generator before any guard invocation.
-- Its stored fingerprints remain opaque and unchanged; currentness is checked
-- by the original callable after alias narrowing, never during this safety phase.
DO $fixture_guard_shape$
DECLARE guard pg_proc;canonical_owner oid;previous_oid oid;source_oid oid;dispatcher_oid oid;
 pinned boolean:=false;feedback boolean:=false;amended boolean:=false;history boolean:=false;privacy boolean:=false;helper pg_proc;
 matched integer;pins text;actual_oids oid[];expected_oids oid[];expected_body text;
BEGIN
 SELECT * INTO guard FROM pg_proc WHERE oid=to_regprocedure('public.application_memory_statement_helpers_current()');
 IF to_regclass('public._migrations') IS NOT NULL THEN
  pinned:=EXISTS(SELECT FROM public._migrations WHERE name='8111_native_memory_statement_visitor.sql');
  feedback:=EXISTS(SELECT FROM public._migrations WHERE name='8112_native_feedback_outcome_projection.sql');
  amended:=EXISTS(SELECT FROM public._migrations WHERE name='8113_native_memory_statement_helper_projection_guard.sql');
  history:=EXISTS(SELECT FROM public._migrations WHERE name='8128_native_memory_history_admission.sql');
  privacy:=EXISTS(SELECT FROM public._migrations WHERE name='8135_channel_recording_privacy_hold.sql');
 END IF;
 IF guard.oid IS NULL THEN
  IF pinned OR feedback OR amended OR history OR privacy THEN RAISE EXCEPTION 'Unknown fixture Memory guard: missing installed guard' USING ERRCODE='55000';END IF;
  RETURN; -- Fresh/pre8111 prefix, including the explicit new-disposable callback.
 END IF;
 IF NOT pinned OR amended AND NOT feedback THEN RAISE EXCEPTION 'Unknown fixture Memory guard: migration phase' USING ERRCODE='55000';END IF;
 IF NOT amended THEN
  IF feedback THEN RAISE EXCEPTION 'Unsupported 8112-only fixture phase; preserve stopped fixture' USING ERRCODE='55000';END IF;
  RAISE EXCEPTION 'Unsupported 120-only fixture phase; preserve stopped fixture' USING ERRCODE='55000';
 END IF;
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid=to_regclass('public.memories');
 IF guard.proowner IS DISTINCT FROM canonical_owner
  OR guard.proowner IS DISTINCT FROM (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.application_memory_field_state_before_successor(uuid,uuid,text[])'))
  OR guard.pronamespace<>'public'::regnamespace OR guard.proname<>'application_memory_statement_helpers_current'
  OR guard.prokind<>'f' OR guard.prorettype<>'boolean'::regtype OR guard.proretset
  OR guard.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
  OR NOT guard.prosecdef OR guard.provolatile<>'v' OR guard.proisstrict OR guard.proparallel<>'u'
  OR guard.proleakproof OR guard.prosupport<>0 OR guard.procost<>100 OR guard.prorows<>0
  OR guard.pronargs<>0 OR guard.pronargdefaults<>0 OR guard.provariadic<>0
  OR guard.proallargtypes IS NOT NULL OR guard.proargmodes IS NOT NULL OR guard.proargnames IS NOT NULL
  OR guard.proargdefaults IS NOT NULL OR guard.protrftypes IS NOT NULL OR guard.probin IS NOT NULL OR guard.prosqlbody IS NOT NULL
  OR guard.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR (SELECT count(*) FROM aclexplode(coalesce(guard.proacl,acldefault('f',guard.proowner))))<>1
  OR EXISTS(SELECT FROM aclexplode(coalesce(guard.proacl,acldefault('f',guard.proowner))) a
   WHERE a.grantee<>guard.proowner OR a.grantor<>guard.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: properties or private ACL' USING ERRCODE='55000';END IF;
 -- 121 bounded tuples plus the fixed generator and its two reviewed source literals.
 IF octet_length(guard.prosrc)>24000 THEN RAISE EXCEPTION 'Unknown fixture Memory guard: body bounds' USING ERRCODE='55000';END IF;
 SELECT string_agg(format('(%s::oid,%L::text)',m[1]::oid,m[2]),',' ORDER BY ordinal),array_agg(m[1]::oid ORDER BY ordinal),count(*)
 INTO pins,actual_oids,matched
 FROM regexp_matches(guard.prosrc,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') WITH ORDINALITY captures(m,ordinal);
 SELECT array_agg(function_oid ORDER BY function_oid) INTO expected_oids
 FROM (SELECT to_regprocedure(signature)::oid AS function_oid FROM unnest(ARRAY[
  'public.agent_read_scope_allows(text,text[],uuid[])',
  'public.agent_scope_grant_allows(text,text[])',
  'public.agent_visibility_allows(uuid,uuid,uuid)',
  'public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)',
  'public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)',
  'public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)',
  'public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)',
  'public.application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)',
  'public.application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)',
  'public.application_field_digest(jsonb)',
  'public.application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])',
  'public.application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])',
  'public.application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])',
  'public.application_field_resource_uuid(text)',
  'public.application_memory_field_keys()',
  'public.application_memory_field_state(uuid,uuid,text[])',
  'public.application_memory_field_state_before_successor(uuid,uuid,text[])',
  'public.application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)',
  'public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)',
  'public.application_memory_query_context(uuid)',
  'public.application_memory_query_domain_state(uuid,uuid,text[])',
  'public.application_memory_statement_domain(uuid,uuid,text[],jsonb)',
  'public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)',
  'public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)',
  'public.application_memory_statement_state(uuid,uuid,text[],jsonb)',
  'public.application_native_catalog_port_valid(regprocedure)',
  'public.application_native_field_catalog_for(uuid,jsonb,text)',
  'public.application_native_field_contract_before_catalog(uuid,jsonb,text,text)',
  'public.application_native_field_contract_for(uuid,jsonb,text,text)',
  'public.application_native_field_rule_allows(jsonb,text[])',
  'public.application_native_member_field_permissions(uuid,jsonb,uuid)',
  'public.application_native_query_bounds(uuid)',
  'public.application_native_record_port_valid(regprocedure)',
  'public.application_native_same_destination(uuid,text,uuid,text,uuid)',
  'public.application_normalize_native_query_bounds(jsonb)',
  'public.application_principal_query_bounds(uuid,uuid,boolean)',
  'public.application_query_scope_cap(integer,jsonb,jsonb)',
  'public.application_query_scope_intersection(jsonb,jsonb)',
  'public.application_query_scope_valid(jsonb)',
  'public.application_query_set_intersection(jsonb,jsonb)',
  'public.application_reader_envelope_visible(uuid,jsonb)',
  'public.application_recorded_field_root_capture(uuid,uuid,text,integer)',
  'public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)',
  'public.application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)',
  'public.application_scope_lineage(uuid,text[],uuid[],text[])',
  'public.application_scope_source_edges(uuid,text,uuid,text)',
  'public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)',
  'public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)',
  'public.application_session_eval_field(uuid,uuid,text,jsonb)',
  'public.application_session_eval_scope(uuid,text,uuid,text,jsonb)',
  'public.assistant_placement_visible(uuid,uuid)',
  'public.department_principal_grant_snapshot(uuid)',
  'public.department_read_grants()',
  'public.department_read_grants_for(uuid)',
  'public.department_row_allows(jsonb,uuid,text,text[],uuid)',
  'public.effective_member_read_compartments(uuid,uuid)',
  'public.effective_member_team_compartments(uuid,uuid)',
  'public.entity_derivation_envelope_valid(jsonb)',
  'public.knowledge_version_source_edges(uuid,text,uuid,text)',
  'public.legacy_assistant_team_compartments(uuid)',
  'public.member_operation_grants(boolean,uuid)',
  'public.member_operation_row_allows(jsonb,uuid,text,text[])',
  'public.member_operation_scope_allows(uuid,text,text[],boolean)',
  'public.member_principal_operation_grants(uuid,boolean,uuid)',
  'public.project_member_live(uuid,text,uuid)',
  'public.read_admitted_native_scope_snapshot(uuid,text,uuid)',
  'public.read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)',
  'public.read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)',
  'public.read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)',
  'public.read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)',
  'public.read_entity_derivation_source(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_application_fields(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_blueprint(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_browser_profile(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_browser_session(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_capture(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_conversation(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_memory_successor(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_page(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_persistent_context(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_recordings(uuid,text,uuid)',
  'public.read_entity_derivation_source_before_workflow_run(uuid,text,uuid)',
  'public.read_external_source_dependencies(uuid,text[],uuid[],text[])',
  'public.read_media_parent_snapshot(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_blueprint(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_browser_session(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_conversation(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_page(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)',
  'public.read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)',
  'public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])',
  'public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)',
  'public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])',
  'public.read_resource_page_dependencies(uuid,text,uuid,text)',
  'public.read_scope_source(uuid,text,uuid)',
  'public.read_scope_source_before_application_fields(uuid,text,uuid)',
  'public.read_scope_source_before_browser_profile(uuid,text,uuid)',
  'public.read_scope_source_before_browser_session(uuid,text,uuid)',
  'public.read_scope_source_before_external(uuid,text,uuid)',
  'public.read_scope_source_before_knowledge_binding(uuid,text,uuid)',
  'public.read_scope_source_before_page(uuid,text,uuid)',
  'public.read_scope_source_before_persistent_context(uuid,text,uuid)',
  'public.read_scope_source_before_routines(uuid,text,uuid)',
  'public.read_scope_source_before_workflow_run(uuid,text,uuid)',
  'public.scope_review_state_held(text,uuid)',
  'public.scope_source_ancestors(uuid,text,uuid)',
  'public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)',
  'public.scope_source_ancestors_before_browser_session(uuid,text,uuid)',
  'public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)',
  'public.scope_source_table(text)',
  'public.scope_source_table_before_knowledge_versions(text)',
  'public.scope_source_table_before_media(text)',
  'public.scope_source_table_before_persistent_context(text)',
  'public.sensitivity_rank(text)',
  'public.workflow_evidence_envelope_visible(uuid,jsonb)'
 ]::text[]) signatures(signature)) identities;
 previous_oid:=to_regprocedure('public.application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])')::oid;
 source_oid:=to_regprocedure('public.read_entity_derivation_source(uuid,text,uuid)')::oid;
 dispatcher_oid:=to_regprocedure('public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])')::oid;
 IF (matched<>(CASE WHEN privacy THEN 126 WHEN history THEN 122 ELSE 121 END)) OR cardinality(expected_oids)<>120 OR array_position(expected_oids,NULL) IS NOT NULL
  OR previous_oid IS NULL OR source_oid IS NULL OR dispatcher_oid IS NULL OR previous_oid=dispatcher_oid
  OR actual_oids[1:120] IS DISTINCT FROM expected_oids OR actual_oids[121] IS DISTINCT FROM dispatcher_oid
  OR (SELECT count(DISTINCT function_oid) FROM unnest(actual_oids) identities(function_oid))<>(CASE WHEN privacy THEN 126 WHEN history THEN 122 ELSE 121 END) THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: closed pin identities' USING ERRCODE='55000';END IF;
 IF privacy AND (NOT history OR actual_oids[123:126] IS DISTINCT FROM ARRAY[
  to_regprocedure('public.session_recording_read_allowed(uuid)')::oid,
  to_regprocedure('public.recording_source_read_allowed(uuid,text,uuid)')::oid,
  to_regprocedure('public.guard_session_recording_privacy()')::oid,
  to_regprocedure('public.refuse_quarantined_recording_message()')::oid]
  OR array_position(actual_oids[123:126],NULL) IS NOT NULL) THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: recording privacy identities' USING ERRCODE='55000';END IF;
 IF history THEN
  SELECT * INTO helper FROM pg_proc WHERE oid=to_regprocedure('public.application_memory_history_status(uuid,uuid,text)');
  IF helper.oid IS NULL OR actual_oids[122] IS DISTINCT FROM helper.oid
   OR helper.proowner IS DISTINCT FROM canonical_owner OR helper.pronamespace<>'public'::regnamespace
   OR helper.proname<>'application_memory_history_status' OR helper.prokind<>'f' OR helper.prorettype<>'jsonb'::regtype
   OR helper.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR helper.proretset OR NOT helper.prosecdef OR helper.provolatile<>'v' OR helper.proisstrict OR helper.proparallel<>'u'
   OR helper.proleakproof OR helper.prosupport<>0 OR helper.procost<>100 OR helper.prorows<>0
   OR helper.pronargs<>3 OR helper.proargtypes<>'2950 2950 25'::oidvector OR helper.pronargdefaults<>0 OR helper.provariadic<>0
   OR helper.proallargtypes IS NOT NULL OR helper.proargmodes IS NOT NULL OR helper.proargnames IS DISTINCT FROM ARRAY['w','i','v']::text[]
   OR helper.proargdefaults IS NOT NULL OR helper.protrftypes IS NOT NULL OR helper.probin IS NOT NULL OR helper.prosqlbody IS NOT NULL
   OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR (SELECT count(*) FROM aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))))<>1
   OR EXISTS(SELECT FROM aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
    WHERE a.grantee<>helper.proowner OR a.grantor<>helper.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
   RAISE EXCEPTION 'Unknown fixture Memory guard: history helper identity or metadata' USING ERRCODE='55000';END IF;
 expected_body:=format($fixture_history_template$ SELECT count(*)=122 AND coalesce(bool_and(coalesce((p.oid<>%s::oid OR p.proname='application_field_projection_state_before_feedback_outcome') AND (p.oid<>%s::oid OR p.prosrc=%L) AND encode(sha256(convert_to((CASE WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('proname','application_field_projection_state') WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('prosrc',%L) ELSE to_jsonb(p) END)::text,'UTF8')),'hex')=pin.fingerprint,false)),false) FROM (VALUES %s) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid $fixture_history_template$,
  previous_oid,source_oid,$fixture_feedback_source$
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
END $fixture_feedback_source$,
  previous_oid,source_oid,$fixture_original_source$
BEGIN
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $fixture_original_source$,pins);
 ELSE
 expected_body:=format($fixture_template$ SELECT count(*)=121 AND coalesce(bool_and(coalesce((p.oid<>%s::oid OR p.proname='application_field_projection_state_before_feedback_outcome') AND (p.oid<>%s::oid OR p.prosrc=%L) AND encode(sha256(convert_to((CASE WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('proname','application_field_projection_state') WHEN p.oid=%s::oid THEN to_jsonb(p)||jsonb_build_object('prosrc',%L) ELSE to_jsonb(p) END)::text,'UTF8')),'hex')=pin.fingerprint,false)),false) FROM (VALUES %s) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid $fixture_template$,
  previous_oid,source_oid,$fixture_feedback_source$
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
END $fixture_feedback_source$,
  previous_oid,source_oid,$fixture_original_source$
BEGIN
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $fixture_original_source$,pins);
 END IF;
 IF privacy THEN
  -- 8135 keeps the reviewed source normalization and adds one exact early
  -- refusal to its complete feedback body. Only the four named pins expand.
  IF array_length(string_to_array(expected_body,E'BEGIN\n IF k=''''feedback_event'''' THEN'),1)<>2 THEN
   RAISE EXCEPTION 'Unknown fixture Memory guard: recording privacy body shape' USING ERRCODE='55000';END IF;
  expected_body:=replace(expected_body,'SELECT count(*)=122','SELECT count(*)=126');
  expected_body:=replace(expected_body,E'BEGIN\n IF k=''''feedback_event'''' THEN',
   E'BEGIN\n -- Recording privacy admission precedes body selection.\n IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;\n IF k=''''feedback_event'''' THEN');
 END IF;
 IF guard.prosrc IS DISTINCT FROM expected_body THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: complete generated body' USING ERRCODE='55000';END IF;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'Unknown fixture Memory guard: invalid pin literal' USING ERRCODE='55000';
END $fixture_guard_shape$;
-- phase: transition
DO $transition$
DECLARE expected record;p pg_proc;before_properties jsonb;alias_name text;entry record;expected_app boolean;
 pinned boolean;amended boolean;feedback boolean;retired_legacy boolean;retired_source boolean;
BEGIN
 IF to_regclass('public._migrations') IS NULL THEN RETURN;END IF;
 IF NOT EXISTS(SELECT FROM public._migrations) THEN RETURN;END IF;
 pinned:=EXISTS(SELECT FROM public._migrations WHERE name='8111_native_memory_statement_visitor.sql');
 amended:=EXISTS(SELECT FROM public._migrations WHERE name='8113_native_memory_statement_helper_projection_guard.sql');
 feedback:=EXISTS(SELECT FROM public._migrations WHERE name='8112_native_feedback_outcome_projection.sql');
 retired_legacy:=EXISTS(SELECT FROM public._migrations WHERE name='8121_application_legacy_authoring_retirement.sql');
 retired_source:=EXISTS(SELECT FROM public._migrations WHERE name='8124_application_source_host_retirement.sql');
 IF feedback AND NOT amended THEN RAISE EXCEPTION 'Unsupported 8112-only fixture phase; preserve stopped fixture';END IF;
 IF pinned IS DISTINCT FROM (to_regprocedure('public.application_memory_statement_helpers_current()') IS NOT NULL)
  OR amended AND NOT pinned OR amended AND NOT feedback OR feedback AND NOT pinned
  OR retired_legacy AND NOT amended OR retired_source AND NOT retired_legacy THEN
  RAISE EXCEPTION 'Unknown fixture migration/guard phase';END IF;
 -- Only the immediate reviewed pre8111 boundary is supported, not arbitrary older chains.
 IF NOT pinned AND NOT EXISTS(SELECT FROM public._migrations WHERE name='8110_canonical_task_author_delete.sql') THEN
  RAISE EXCEPTION 'Unsupported pre8111 fixture boundary; preserve stopped fixture';END IF;
 -- These closed private suffix entries cannot come from the old mirror.
 -- An alias or any other nonowner grant here is unknown drift, never cleanup.
 FOR entry IN SELECT signature FROM (VALUES
 ('guard_application_legacy_review_metadata()'),('application_legacy_review_authorize(uuid,uuid)'),
 ('application_legacy_inventory_registry()'),('application_legacy_review_snapshot(uuid,text,uuid)'),
 ('application_legacy_review_impact(uuid,text,uuid)'),('application_legacy_repair_plan(uuid,uuid)'),
 ('application_force_native_task_written_field()'),('application_record_native_task_write_intent(tasks,text[],text)'),
 ('application_recheck_native_task_write_intent()'),('application_scoped_grant_allowed_before_records(uuid,jsonb)')
 ) private(signature) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.'||entry.signature);
  IF NOT FOUND OR EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
   RAISE EXCEPTION 'Unknown private suffix ACL: %',entry.signature;END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
 ('read_admitted_native_scope_snapshot(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','memories','jsonb',NULL,NULL,'memory'),
 ('application_legacy_inventory(uuid,uuid,text,uuid)','workspace_scope_reviews','jsonb','1071307902b8f5f9bcff54d7d09918c2','1071307902b8f5f9bcff54d7d09918c2','inventory'),
 ('application_legacy_review_view(uuid,uuid,uuid)','workspace_scope_reviews','jsonb','67345ea54ed84f7a17cc4a19bd5ab506','67345ea54ed84f7a17cc4a19bd5ab506','legacy'),
 ('application_legacy_review_preview(uuid,uuid,text,uuid[],text,text)','workspace_scope_reviews','jsonb','df4dc59689fa6c67b180f53469dca88a','df4dc59689fa6c67b180f53469dca88a','inventory'),
 ('application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean)','workspace_scope_reviews','jsonb','35be9aed39c66a07ced2156b2a061379','35be9aed39c66a07ced2156b2a061379','legacy'),
 ('application_prepare_source_setup(uuid,uuid,jsonb)','application_source_setup_reviews','uuid','48e848488b37a3323fcebc6c6e35cb28','3e21c64061e13a65f183171d7a26c87a','source'),
 ('application_apply_source_setup(uuid,uuid)','application_source_setup_reviews','uuid','efabf2268edcf8892c1bca555e70741e','2dfeeddbe62e2345ba9ec1847e6608f8','source')
 ) contract(signature,owner_table,return_type,before_hash,after_hash,kind) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR to_regclass('public.'||expected.owner_table) IS NULL OR p.proowner<>(SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||expected.owner_table))
   OR p.prokind<>'f' OR p.prorettype<>to_regtype(expected.return_type)
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR NOT p.prosecdef
   OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.proisstrict OR p.proleakproof OR p.proretset
   OR p.provariadic<>0 OR p.proargmodes IS NOT NULL OR p.proallargtypes IS NOT NULL
   OR p.prosupport<>0 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL OR p.procost<>100 OR p.prorows<>0
   OR p.proargnames IS DISTINCT FROM (CASE
    WHEN expected.kind='memory' THEN ARRAY['w','k','i']
    WHEN expected.signature='application_prepare_source_setup(uuid,uuid,jsonb)' THEN ARRAY['w','a','p']
    WHEN expected.signature='application_apply_source_setup(uuid,uuid)' THEN ARRAY['r','approval_id']
    WHEN expected.signature='application_legacy_inventory(uuid,uuid,text,uuid)' THEN ARRAY['w','acting','k','after_id']
    WHEN expected.signature='application_legacy_review_view(uuid,uuid,uuid)' THEN ARRAY['w','acting','target_review']
    WHEN expected.signature='application_legacy_review_preview(uuid,uuid,text,uuid[],text,text)' THEN ARRAY['w','acting','k','ids','operation','reason_value']
    ELSE ARRAY['w','acting','target_review','expected','payload','cancel_value'] END)
   OR p.proconfig IS DISTINCT FROM (CASE WHEN expected.kind='source' THEN ARRAY['search_path=pg_catalog, public'] ELSE ARRAY['search_path=pg_catalog, public, pg_temp'] END)
   OR p.pronargdefaults<>(CASE WHEN expected.signature IN('application_legacy_inventory(uuid,uuid,text,uuid)','application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean)') THEN 1 ELSE 0 END)
   OR pg_get_expr(p.proargdefaults,0) IS DISTINCT FROM (CASE expected.signature WHEN 'application_legacy_inventory(uuid,uuid,text,uuid)' THEN 'NULL::uuid' WHEN 'application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean)' THEN 'false' ELSE NULL END) THEN
   RAISE EXCEPTION 'Unknown fixture function properties: %',expected.signature;END IF;
  -- Pre8111 body admission belongs to the unchanged runner gate, not a substitute checker.
  -- Non-pinned suffix entries have fixed, phase-specific definitions, never live repinning.
  IF expected.kind<>'memory' AND md5(p.prosrc)<>(CASE WHEN expected.kind='source' AND retired_source THEN expected.after_hash ELSE expected.before_hash END) THEN
   RAISE EXCEPTION 'Unknown fixture suffix body: %',expected.signature;END IF;
  expected_app:=NOT(expected.kind='inventory' AND retired_legacy);
  IF EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR NOT(a.grantee=p.proowner OR expected_app AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')
      OR a.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app'))))
   OR NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=p.proowner)
   OR expected_app AND NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')) THEN
   RAISE EXCEPTION 'Unknown fixture function ACL: %',expected.signature;END IF;
  before_properties:=to_jsonb(p)-'proacl';
  FOR alias_name IN SELECT r.rolname FROM pg_roles r WHERE r.rolname IN('assurance_app','admin_fixture_app')
   AND EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=r.oid) LOOP
   EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM %I',expected.signature,alias_name);
  END LOOP;
  IF (SELECT to_jsonb(current_row)-'proacl' FROM pg_proc current_row WHERE oid=p.oid) IS DISTINCT FROM before_properties THEN
   RAISE EXCEPTION 'Fixture cleanup changed function properties: %',expected.signature;END IF;
 END LOOP;
 IF pinned THEN
  IF public.application_memory_statement_helpers_current() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Original Memory helper guard not restored; cleanup rolled back';END IF;
 END IF;
END $transition$;
-- phase: activate
DO $$ BEGIN
 IF to_regclass('public._migrations') IS NULL THEN RAISE EXCEPTION 'Cannot activate runtime before successful migration prefix';END IF;
 IF NOT EXISTS(SELECT FROM public._migrations) THEN RAISE EXCEPTION 'Cannot activate runtime before successful migration prefix';END IF;
 IF to_regprocedure('public.application_memory_statement_helpers_current()') IS NOT NULL THEN
  IF public.application_memory_statement_helpers_current() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Canonical Memory helper guard unavailable';END IF;
 END IF;
END $$;
ALTER ROLE app_user LOGIN PASSWORD '__RUNTIME_PASSWORD__';
ALTER ROLE app_user SET app.current_user_id='00000000-0000-0000-0000-000000000000';
REVOKE ALL ON public._migrations FROM app_user;
DO $$ DECLARE alias_name text;BEGIN
 FOR alias_name IN SELECT rolname FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app') LOOP
  EXECUTE format('ALTER ROLE %I NOLOGIN',alias_name);
 END LOOP;
END $$;
-- phase: verify
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user' AND rolcanlogin
  AND rolconfig @> ARRAY['app.current_user_id=00000000-0000-0000-0000-000000000000']) THEN RAISE EXCEPTION 'Canonical runtime LOGIN missing';END IF;
 IF to_regclass('public._migrations') IS NULL THEN RAISE EXCEPTION 'Runtime migration ledger missing';END IF;
 IF has_table_privilege('app_user','public._migrations','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'Runtime migration ledger must remain private';END IF;
 IF to_regprocedure('public.application_memory_statement_helpers_current()') IS NOT NULL THEN
  IF public.application_memory_statement_helpers_current() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Canonical Memory helper guard unavailable';END IF;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app') AND rolcanlogin) THEN RAISE EXCEPTION 'Retired alias LOGIN remains active';END IF;
END $$;
