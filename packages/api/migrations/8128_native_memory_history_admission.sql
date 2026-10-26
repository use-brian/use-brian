BEGIN;
-- [COMP:corrections/row-history] Current historical purpose, never live factual admission.
DO $fixture_guard_shape$
DECLARE guard pg_proc;canonical_owner oid;previous_oid oid;source_oid oid;dispatcher_oid oid;
 pinned boolean:=false;feedback boolean:=false;amended boolean:=false;
 matched integer;pins text;actual_oids oid[];expected_oids oid[];expected_body text;
BEGIN
 SELECT * INTO guard FROM pg_proc WHERE oid=to_regprocedure('public.application_memory_statement_helpers_current()');
 IF to_regclass('public._migrations') IS NOT NULL THEN
  pinned:=EXISTS(SELECT FROM public._migrations WHERE name='8111_native_memory_statement_visitor.sql');
  feedback:=EXISTS(SELECT FROM public._migrations WHERE name='8112_native_feedback_outcome_projection.sql');
  amended:=EXISTS(SELECT FROM public._migrations WHERE name='8113_native_memory_statement_helper_projection_guard.sql');
 END IF;
 IF guard.oid IS NULL THEN
  IF pinned OR feedback OR amended THEN RAISE EXCEPTION 'Unknown fixture Memory guard: missing installed guard' USING ERRCODE='55000';END IF;
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
 IF matched<>121 OR cardinality(expected_oids)<>120 OR array_position(expected_oids,NULL) IS NOT NULL
  OR previous_oid IS NULL OR source_oid IS NULL OR dispatcher_oid IS NULL OR previous_oid=dispatcher_oid
  OR actual_oids[1:120] IS DISTINCT FROM expected_oids OR actual_oids[121] IS DISTINCT FROM dispatcher_oid
  OR (SELECT count(DISTINCT function_oid) FROM unnest(actual_oids) identities(function_oid))<>121 THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: closed pin identities' USING ERRCODE='55000';END IF;
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
 IF guard.prosrc IS DISTINCT FROM expected_body THEN
  RAISE EXCEPTION 'Unknown fixture Memory guard: complete generated body' USING ERRCODE='55000';END IF;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'Unknown fixture Memory guard: invalid pin literal' USING ERRCODE='55000';
END $fixture_guard_shape$;
DO $history_prerequisites$
DECLARE entry record;actual pg_proc;acl jsonb;canonical_owner oid;
BEGIN
 IF application_memory_statement_helpers_current() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Memory history original helper guard unavailable';END IF;
 IF to_regprocedure('public.application_memory_history_status(uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'Memory history status identity already exists';END IF;
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 FOR entry IN SELECT key AS signature,value AS expected FROM jsonb_each($history_expected${"application_memory_history_field_state(uuid,uuid,text,text[])":{"sha256":"56ed4b131814a330929f60ed808cea3400ee9ac809e6bc30603a6ef7eacc8fbc","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_history_field_state","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","fields"],"proargtypes":["2950","2950","25","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false]]},"application_memory_historical_contract_before_catalog(uuid,jsonb,text,text)":{"sha256":"65a0cd5d26fc7b2e791244134d3dfb0312fee7b9ea973c77c2957c8f8b06cc28","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_historical_contract_before_catalog","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","p_origin","p_type","p_id"],"proargtypes":["2950","3802","25","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false]]},"read_native_memory_history_projection(uuid,uuid,text)":{"sha256":"b3cd7fbd82fb99aec670b028bc3638301fb1e1beb41d264eb7bba461dbde9e14","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_memory_history_projection","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v"],"proargtypes":["2950","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false],["app_user","OWNER","EXECUTE",false]]},"application_field_envelope_ancestry_allowed(uuid,jsonb)":{"sha256":"95eb89fff18ed7d445d729f0762864882c8245eff5efcede8a696d70ee883d07","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_field_envelope_ancestry_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","envelope"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false]]},"application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)":{"sha256":"a1ab7ec9c6235a764ee8ea34a7beda114daf9813b7d95330410c71cf677ee991","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_canonical_ancestry_allowed","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","writing"],"proargtypes":["2950","25","2950","25","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1},"acl":[["OWNER","OWNER","EXECUTE",false]]},"application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)":{"sha256":"8e295f080c2b0840aa61fa00125698f2a2a208c648458778a8c42cf10b055849","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_canonical_ancestry_from_admitted_root","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","writing","trusted_root"],"proargtypes":["2950","25","2950","25","16","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]} {CONST :consttype 3802 :consttypmod -1 :constcollid 0 :constlen -1 :constbyval false :constisnull true :location -1 :constvalue <>})","pronargdefaults":2},"acl":[["OWNER","OWNER","EXECUTE",false]]},"read_native_attended_memory_evidence(uuid,text[],uuid[],text[])":{"sha256":"f027c493c8d28ea5d7a710c4cb209b71ea1b0fdb21a29461923d46b8d105d00f","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_attended_memory_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false],["app_user","OWNER","EXECUTE",false]]},"application_memory_statement_helpers_current()":{"sha256":null,"language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_statement_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false]]},"application_scope_source_edges(uuid,text,uuid,text)":{"sha256":"14535b6ea617c43c10f030e519d61bfc558f649876530f9d9f03cc019f7d6be3","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_source_edges","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false]]},"read_native_session_field_dependencies(uuid,text[],uuid[],text[])":{"sha256":"4a4fa7089bb70f77852d41cd10331ad4b7c2016ded48cae4044fb564cf52a757","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"acl":[["OWNER","OWNER","EXECUTE",false],["app_user","OWNER","EXECUTE",false]]}}$history_expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||entry.signature);
  IF NOT FOUND OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=entry.expected->>'language')
   OR (CASE WHEN entry.signature IN('application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)',
     'application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)') THEN
    (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM ((entry.expected->'metadata')-'proargdefaults')
    OR pg_catalog.pg_get_expr(actual.proargdefaults,0) IS DISTINCT FROM CASE entry.signature
     WHEN 'application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)' THEN 'false' ELSE 'false, NULL::jsonb' END
    ELSE to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM entry.expected->'metadata' END)
   OR entry.expected->>'sha256' IS NOT NULL AND encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM entry.expected->>'sha256' THEN
   RAISE EXCEPTION 'Memory history function prerequisite changed: %',entry.signature;END IF;
  SELECT jsonb_agg(value ORDER BY value::text) INTO acl FROM(
   SELECT jsonb_build_array(CASE WHEN a.grantee=canonical_owner THEN 'OWNER' WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    CASE WHEN a.grantor=canonical_owner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,a.privilege_type,a.is_grantable) AS value
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a) entries;
  IF acl IS DISTINCT FROM (SELECT jsonb_agg(value ORDER BY value::text) FROM jsonb_array_elements(entry.expected->'acl') value
    WHERE value->>0<>'app_user' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user')) THEN
   RAISE EXCEPTION 'Memory history ACL prerequisite changed: %',entry.signature;END IF;
 END LOOP;
END $history_prerequisites$;
CREATE FUNCTION application_memory_history_status(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $history_status$DECLARE selected memories;row_value memories;entry jsonb;transition native_memory_successor_transitions;
 receipt jsonb;state scope_resource_states;item jsonb;field application_field_resources;observation application_field_observations;
 ids uuid[]:=ARRAY[i];seen uuid[]:='{}';pending uuid;parents uuid[];forward_seen uuid[];cursor_id uuid;
 chain jsonb:='[]';transitions jsonb:='[]';receipts jsonb:='[]';anchors jsonb:='[]';own_fields jsonb:='[]';roots jsonb:='[]';
 protected boolean;actual_state jsonb;matched boolean;successor memories;successor_receipt jsonb;derivation scope_derivations;
 derivation_version text;points jsonb;retirement_fields jsonb:='[]';retraction_fields jsonb:='[]';retraction_roots jsonb:='[]';retirements jsonb:='[]';
 independent_roots jsonb;independent_nodes jsonb:='[]';queue jsonb;walk jsonb;child jsonb;walk_index integer:=0;
BEGIN
 SELECT * INTO selected FROM memories WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR selected.scope_version::text IS DISTINCT FROM v THEN RETURN NULL;END IF;
 WHILE cardinality(ids)>0 LOOP
  pending:=ids[1];ids:=ids[2:];IF pending=ANY(seen) THEN CONTINUE;END IF;
  seen:=array_append(seen,pending);IF cardinality(seen)>100 THEN RETURN NULL;END IF;
  SELECT * INTO row_value FROM memories WHERE id=pending;
  IF NOT FOUND OR row_value.workspace_id IS DISTINCT FROM w THEN RETURN NULL;END IF;
  SELECT array_agg(id ORDER BY id) INTO parents FROM memories WHERE workspace_id=w AND superseded_by=pending;
  IF cardinality(parents)>1 THEN RETURN NULL;END IF;
  ids:=ids||coalesce(parents,'{}');
  IF row_value.superseded_by IS NOT NULL THEN
   IF row_value.valid_to IS NULL THEN RETURN NULL;END IF;
   ids:=array_append(ids,row_value.superseded_by);
  END IF;
  chain:=chain||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',row_value.scope_version::text,
   'held',row_value.scope_held,'validTo',row_value.valid_to,'supersededBy',row_value.superseded_by,
   'retractedAt',row_value.retracted_at,'retractedBy',row_value.retracted_by,
   'scope',jsonb_build_object('workspaceId',w,'userId',row_value.user_id,'assistantId',row_value.assistant_id,
    'sensitivity',row_value.sensitivity,'compartments',row_value.compartments,'projectIds',row_value.project_ids)));
 END LOOP;
 -- A real physical chain may be unprotected; mere consumer observations are not outgoing provenance.
 protected:=EXISTS(SELECT 1 FROM scope_derivations WHERE workspace_id=w AND resource_kind='memory' AND resource_id=ANY(seen))
  OR EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=ANY(seen) AND(source_session_id IS NOT NULL OR source_episode_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM native_memory_successor_transitions WHERE workspace_id=w AND(predecessor_id=ANY(seen) OR successor_id=ANY(seen)))
  OR EXISTS(SELECT 1 FROM correction_audit WHERE workspace_id=w AND row_id=ANY(seen) AND native_memory_transition IS NOT NULL);
 FOR entry IN SELECT value FROM jsonb_array_elements(chain) ORDER BY value->>'id' LOOP
  SELECT * INTO row_value FROM memories WHERE workspace_id=w AND id=(entry->>'id')::uuid;
  cursor_id:=row_value.id;forward_seen:='{}';
  LOOP
   IF cursor_id=ANY(forward_seen) THEN RETURN NULL;END IF;
   forward_seen:=array_append(forward_seen,cursor_id);
   SELECT superseded_by INTO cursor_id FROM memories WHERE workspace_id=w AND id=cursor_id;
   IF NOT FOUND THEN RETURN NULL;END IF;EXIT WHEN cursor_id IS NULL;
  END LOOP;
  anchors:=anchors||jsonb_build_array(jsonb_build_object('kind','memory','id',row_value.id,'version',row_value.scope_version::text));
  IF row_value.superseded_by IS NOT NULL THEN
   SELECT * INTO transition FROM native_memory_successor_transitions WHERE workspace_id=w AND predecessor_id=row_value.id
    AND predecessor_version=row_value.scope_version::text AND successor_id=row_value.superseded_by;
   IF NOT FOUND THEN
    -- Absence is proved for this legacy creation edge, not inferred from a
    -- convenient later authenticated version elsewhere in the physical chain.
    SELECT * INTO successor FROM memories WHERE workspace_id=w AND id=row_value.superseded_by;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory'
      AND d.resource_id IN(row_value.id,successor.id))
     OR row_value.source_session_id IS NOT NULL OR row_value.source_episode_id IS NOT NULL
     OR successor.source_session_id IS NOT NULL OR successor.source_episode_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM correction_audit a WHERE a.workspace_id=w AND a.row_id IN(row_value.id,successor.id) AND a.native_memory_transition IS NOT NULL)
     OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w
      AND(t.successor_id IN(row_value.id,successor.id) OR t.predecessor_id=row_value.id)) THEN RETURN NULL;END IF;
   ELSE
    transitions:=transitions||jsonb_build_array(to_jsonb(transition));
    SELECT * INTO successor FROM memories WHERE workspace_id=w AND id=transition.successor_id;
    IF NOT FOUND THEN RETURN NULL;END IF;
    derivation_version:=successor.scope_version::text;
    IF successor.retracted_at IS NOT NULL THEN
     SELECT native_memory_transition INTO successor_receipt FROM correction_audit WHERE workspace_id=w AND row_id=successor.id
      AND primitive='memory' AND action='retract' AND native_memory_transition->>'kind'='native_memory_retract_v1';
     IF NOT FOUND OR successor_receipt->>'resultVersion' IS DISTINCT FROM successor.scope_version::text
      OR successor_receipt->>'priorVersion' IS DISTINCT FROM (successor.scope_version-1)::text
      OR successor_receipt->>'actorId' IS DISTINCT FROM successor.retracted_by::text THEN RETURN NULL;END IF;
     derivation_version:=successor_receipt->>'priorVersion';
    END IF;
    SELECT * INTO derivation FROM scope_derivations WHERE workspace_id=w AND resource_kind='memory'
     AND resource_id=successor.id AND resource_version=derivation_version;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources e WHERE e.workspace_id=w AND e.derivation_id=derivation.id
      AND e.source_kind='memory' AND e.source_id=transition.predecessor_id AND e.source_version=transition.predecessor_version) THEN RETURN NULL;END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',e.source_kind,'id',e.source_id,'version',e.source_version) ORDER BY e.source_kind,e.source_id),'[]')
     INTO item FROM scope_derivation_sources e WHERE e.workspace_id=w AND e.derivation_id=derivation.id;
    roots:=roots||item;IF jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
    retirements:=retirements||jsonb_build_array(jsonb_build_object('transition',to_jsonb(transition),'derivation',to_jsonb(derivation),'roots',item));
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind','application_field','id',f.id,'version',o.version)),'[]') INTO points FROM scope_derivation_sources e
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=e.source_id
     JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=e.source_version
     WHERE e.workspace_id=w AND e.derivation_id=derivation.id AND e.source_kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.resource_id=transition.predecessor_id
      AND f.selection='read' AND f.selected_version IS NULL
      AND f.fields=ARRAY(SELECT key FROM unnest(application_memory_field_keys()) key ORDER BY key)
      AND o.source_kind='memory' AND o.source_id=transition.predecessor_id
      AND o.record_version=transition.predecessor_version AND o.source_version=transition.predecessor_version;
    IF jsonb_array_length(points)>1 THEN RETURN NULL;END IF;
    retirement_fields:=retirement_fields||points;
   END IF;
  ELSIF row_value.valid_to IS NOT NULL AND row_value.retracted_at IS NULL THEN RETURN NULL;
  END IF;
  IF row_value.retracted_at IS NOT NULL THEN
   SELECT native_memory_transition INTO receipt FROM correction_audit WHERE workspace_id=w AND row_id=row_value.id
    AND primitive='memory' AND action='retract' AND native_memory_transition->>'kind'='native_memory_retract_v1';
   IF NOT FOUND OR receipt->>'resultVersion' IS DISTINCT FROM row_value.scope_version::text
    OR receipt->>'priorVersion' IS DISTINCT FROM (row_value.scope_version-1)::text
    OR receipt->>'actorId' IS DISTINCT FROM row_value.retracted_by::text
    OR jsonb_typeof(receipt->'originalRoots') IS DISTINCT FROM 'array'
    OR jsonb_typeof(receipt#>'{reasonEvidence,sources}') IS DISTINCT FROM 'array'
    OR receipt->'writeFields' IS DISTINCT FROM '["retracted_at","retracted_reason","retracted_by","valid_to"]'::jsonb THEN RETURN NULL;END IF;
   SELECT * INTO state FROM scope_resource_states WHERE workspace_id=w AND resource_kind='memory' AND resource_id=row_value.id AND resource_version=row_value.scope_version::text;
   matched:=FOUND;actual_state:=CASE WHEN matched THEN jsonb_build_object('workspaceId',w,'resourceKind','memory','resourceId',row_value.id,
    'resourceVersion',row_value.scope_version::text,'reviewState',state.review_state,'classificationRevision',state.classification_revision::text,'holdingReason',state.holding_reason) ELSE 'null'::jsonb END;
   IF row_value.scope_held THEN
    IF NOT matched OR state.review_state IS DISTINCT FROM 'held' OR state.holding_reason IS DISTINCT FROM 'source_changed'
     OR receipt->'resultHoldState' IS DISTINCT FROM actual_state THEN RETURN NULL;END IF;
   ELSIF matched AND state.review_state='held' THEN RETURN NULL;
   END IF;
   anchors:=anchors||jsonb_build_array(jsonb_build_object('kind','memory','id',row_value.id,'version',receipt->>'priorVersion'));
   receipts:=receipts||jsonb_build_array(jsonb_build_object('id',row_value.id,'receipt',receipt,'state',actual_state));
   roots:=roots||(receipt->'originalRoots');retraction_roots:=retraction_roots||(receipt->'originalRoots');
   SELECT coalesce(jsonb_agg(jsonb_build_object('kind','application_field','id',f.id,'version',o.version)),'[]') INTO points
    FROM jsonb_array_elements(receipt->'originalRoots') r
    JOIN application_field_resources f ON r->>'kind'='application_field' AND f.workspace_id=w AND f.id=(r->>'id')::uuid
    JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=r->>'version'
    WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.resource_id=row_value.id
     AND f.selection='read' AND f.selected_version IS NULL
     AND f.fields=ARRAY(SELECT key FROM unnest(application_memory_field_keys()) key ORDER BY key)
     AND o.source_kind='memory' AND o.source_id=row_value.id
     AND o.record_version=receipt->>'priorVersion' AND o.source_version=receipt->>'priorVersion';
   IF jsonb_array_length(points)<>1 THEN RETURN NULL;END IF;
   retraction_fields:=retraction_fields||points;
   IF jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
  ELSIF row_value.scope_held OR scope_review_state_held('memory',row_value.id) THEN RETURN NULL;
  END IF;
 END LOOP;
 FOR item IN SELECT DISTINCT value FROM jsonb_array_elements(roots) WHERE value->>'kind'='application_field' LOOP
  SELECT * INTO field FROM application_field_resources WHERE workspace_id=w AND id=(item->>'id')::uuid;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=field.id AND version=item->>'version';
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF field.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND field.type_key='memory'
   AND field.resource_id=ANY(seen) AND observation.source_kind='memory' AND observation.source_id=field.resource_id
   AND observation.record_version=observation.source_version
   AND anchors @> jsonb_build_array(jsonb_build_object('kind','memory','id',observation.source_id,'version',observation.source_version))
   AND (retraction_fields @> jsonb_build_array(item) OR retirement_fields @> jsonb_build_array(item)) THEN
   own_fields:=own_fields||jsonb_build_array(jsonb_build_object('kind','application_field','id',field.id,'version',observation.version,
    'resource',to_jsonb(field),'observation',to_jsonb(observation)));
  END IF;
 END LOOP;
 -- Preserve observable independent paths before any tuple projection. The
 -- fixed metadata walk uses the unchanged Knowledge/predecessor edge kernel;
 -- encountering nested historical purpose refuses rather than recursing.
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO independent_roots FROM(SELECT DISTINCT root.value FROM jsonb_array_elements(roots) root(value)
  WHERE NOT anchors @> jsonb_build_array(root.value) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(own_fields) own(value)
   WHERE own.value->>'kind'=root.value->>'kind' AND own.value->>'id'=root.value->>'id' AND own.value->>'version'=root.value->>'version')) seeds;
 queue:=independent_roots;
 WHILE walk_index<jsonb_array_length(queue) LOOP
  walk:=queue->walk_index;walk_index:=walk_index+1;
  IF independent_nodes @> jsonb_build_array(walk) THEN CONTINUE;END IF;
  independent_nodes:=independent_nodes||jsonb_build_array(walk);
  IF jsonb_array_length(independent_nodes)>4096 THEN RETURN NULL;END IF;
  IF walk->>'kind'='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w
   AND f.id=(walk->>'id')::uuid AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN RETURN NULL;END IF;
  FOR child IN SELECT to_jsonb(e) FROM knowledge_version_source_edges(w,walk->>'kind',(walk->>'id')::uuid,walk->>'version') e LOOP
   IF child->>'kind' IS NULL OR child->>'id' IS NULL OR child->>'version' IS NULL THEN RETURN NULL;END IF;
   IF NOT independent_nodes @> jsonb_build_array(child) THEN queue:=queue||jsonb_build_array(child);END IF;
   IF jsonb_array_length(queue)>8192 THEN RETURN NULL;END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'kind',value->>'id',value->>'version'),'[]') INTO independent_nodes FROM jsonb_array_elements(independent_nodes);
 SELECT coalesce(jsonb_agg(own ORDER BY own::text),'[]') INTO own_fields FROM jsonb_array_elements(own_fields) own
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(independent_nodes) required
   WHERE required->>'kind'=own->>'kind' AND required->>'id'=own->>'id' AND required->>'version'=own->>'version');
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO chain FROM jsonb_array_elements(chain);
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO roots FROM(SELECT DISTINCT value FROM jsonb_array_elements(roots)) values_only;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO anchors FROM(SELECT DISTINCT value FROM jsonb_array_elements(anchors)) values_only;
 RETURN jsonb_build_object('kind','native-memory-history-status-v1','workspaceId',w,'id',i,'version',v,'protected',protected,
  'chain',chain,'transitions',transitions,'retirements',retirements,'receipts',receipts,'anchors',anchors,'ownFields',own_fields,
  'qualifiedAnchors',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements(anchors) a WHERE NOT independent_nodes @> jsonb_build_array(a)),
  'independentRoots',independent_roots,'independentNodes',independent_nodes,'roots',roots);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END
$history_status$;
REVOKE ALL ON FUNCTION application_memory_history_status(uuid,uuid,text) FROM PUBLIC;
DO $history_status_owner$ DECLARE canonical_owner text;BEGIN
 SELECT pg_get_userbyid(relowner) INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 EXECUTE format('ALTER FUNCTION application_memory_history_status(uuid,uuid,text) OWNER TO %I',canonical_owner);
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION application_memory_history_status(uuid,uuid,text) FROM app_user;END IF;
END $history_status_owner$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.application_memory_historical_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_memory_historical_contract_before_catalog(w uuid, p_origin jsonb, p_type text, p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
<<memory_history_contract>> DECLARE canonical_origin jsonb:=p_origin; canonical_type text:=p_type; contract application_native_field_contracts;
 namespace text; procedure_name text; metadata jsonb; source jsonb; keys text[]; field jsonb; profile jsonb; fingerprint text;
BEGIN
 IF p_origin->>'kind'='generic' THEN
  IF p_origin-ARRAY['kind','entityTypeId']<>'{}'::jsonb THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  canonical_origin:=jsonb_build_object('kind','generic','entityTypeId',((p_origin->>'entityTypeId')::uuid)::text);
  canonical_type:='record.'||(canonical_origin->>'entityTypeId');
 END IF;
 SELECT c.* INTO contract FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=canonical_type;
 IF NOT FOUND THEN RETURN '{"registered":false}'::jsonb; END IF;
 IF public.application_native_configuration_verified(w,contract.module_key) IS NOT TRUE THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.metadata_reader;
 IF namespace IS NULL THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 EXECUTE format('SELECT %I.%I($1,$2,$3,$4)',namespace,procedure_name) INTO metadata USING w,canonical_origin,canonical_type,p_id;
 IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
  OR NOT metadata ?& ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']
  OR metadata-ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']<>'{}'::jsonb
  OR metadata->>'moduleKey' IS DISTINCT FROM contract.module_key OR metadata->'origin' IS DISTINCT FROM canonical_origin
  OR metadata->>'typeKey' IS DISTINCT FROM canonical_type OR jsonb_typeof(metadata->'recordVersion') IS DISTINCT FROM 'string'
  OR length(metadata->>'recordVersion') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(metadata->'schemaVersion') IS DISTINCT FROM 'string' OR jsonb_typeof(metadata->'policyVersion') IS DISTINCT FROM 'string'
  OR length(metadata->>'schemaVersion') NOT BETWEEN 1 AND 128 OR length(metadata->>'policyVersion') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(metadata->'fieldKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(metadata->'fields') IS DISTINCT FROM 'array'
  OR jsonb_array_length(metadata->'fieldKeys')>128 OR jsonb_array_length(metadata->'fields')<>jsonb_array_length(metadata->'fieldKeys')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(metadata->'fieldKeys') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 128
   OR item#>>'{}'=ANY(ARRAY['__proto__','prototype','constructor'])) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 keys:=ARRAY(SELECT jsonb_array_elements_text(metadata->'fieldKeys'));
 IF cardinality(keys)<>(SELECT count(DISTINCT field_key) FROM unnest(keys) field_key)
  OR cardinality(keys)<>(SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(metadata->'fields')) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 source:=metadata->'source';
 IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR source->>'workspaceId' IS DISTINCT FROM w::text
  OR source->>'version' IS DISTINCT FROM metadata->>'recordVersion' OR entity_derivation_envelope_valid(source) IS NOT TRUE
  THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 IF canonical_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND canonical_type='memory' THEN
  IF application_memory_history_status(w,p_id::uuid,metadata->>'recordVersion') IS NULL THEN
   RETURN '{"registered":true,"held":true}'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(ARRAY_TO_JSON(ARRAY['workspaceId','resourceKind','resourceId','userId','assistantId','sensitivity','compartments','projectIds','version','held','validTo','retractedAt'])::jsonb) key
    WHERE source->key IS DISTINCT FROM read_scope_source(w,'memory',p_id::uuid)->key) THEN
   RETURN '{"registered":true,"held":true}'::jsonb;END IF;
 ELSIF source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL THEN
  RETURN '{"registered":true,"held":true}'::jsonb;
 END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(metadata->'fields') LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR NOT field ?& ARRAY['key','read','write','releaseReadTo','releaseWriteTo']
   OR field-ARRAY['key','read','write','releaseReadTo','releaseWriteTo']<>'{}'::jsonb OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string'
   OR NOT coalesce(field->>'key'=ANY(keys),false)
   OR application_native_field_rule_valid(field->'read',contract.role_keys) IS NOT TRUE
   OR application_native_field_rule_valid(field->'write',contract.role_keys) IS NOT TRUE THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  FOR profile IN SELECT value FROM jsonb_array_elements(jsonb_build_array(field->'releaseReadTo',field->'releaseWriteTo')) LOOP
   IF jsonb_typeof(profile) IS DISTINCT FROM 'array' OR jsonb_array_length(profile)>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(profile) item WHERE item NOT IN('"external_user"'::jsonb,'"service"'::jsonb))
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(profile)) THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  END LOOP;
 END LOOP;
 fingerprint:=application_field_digest(jsonb_build_object('contract',contract.contract_version,'roles',contract.role_keys,
  'schema',metadata->'schemaVersion','policy',metadata->'policyVersion','fields',metadata->'fields'));
 RETURN jsonb_build_object('registered',true,'held',false,'metadata',metadata,'roleKeys',contract.role_keys,'fingerprint',fingerprint);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow
 OR undefined_function OR undefined_table OR insufficient_privilege THEN RETURN '{"registered":true,"held":true}'::jsonb;
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.application_memory_historical_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_memory_historical_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure) IS DISTINCT FROM 'd5e850026ad7e7ea63326941f44eba9c182059980dac14d61f564f83860fbcb0' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.application_memory_history_field_state(uuid,uuid,text,text[])'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_memory_history_field_state(w uuid, i uuid, v text, fields text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$DECLARE context jsonb;source jsonb;policy jsonb;mask jsonb;proof jsonb;fingerprints jsonb:='[]';values_json jsonb:='{}';
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;field text;selected_value jsonb;root jsonb;current_source jsonb;own jsonb;
 own_row memories;own_policy jsonb;own_mask jsonb;own_keys text[];
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RETURN NULL;END IF;
 context:=application_memory_query_context(w);
 IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
 proof:=application_memory_history_status(w,i,v);IF proof IS NULL THEN RETURN NULL;END IF;
 source:=read_scope_source(w,'memory',i);
 IF source IS NULL OR source->>'version' IS DISTINCT FROM v
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN NULL;END IF;
 policy:=application_memory_historical_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',i::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM v THEN RETURN NULL;END IF;
  mask:=read_native_memory_historical_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',i::text,v);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
 END IF;
 -- Exact used own fields retain both their immutable source floor and current
 -- selected-row policy. This check never makes their old factual read current.
 FOR own IN SELECT value FROM jsonb_array_elements(proof->'ownFields') LOOP
  SELECT * INTO own_row FROM memories WHERE workspace_id=w AND id=(own#>>'{resource,resource_id}')::uuid;
  IF NOT FOUND OR workflow_evidence_envelope_visible(w,own#>'{observation,source_scope}') IS NOT TRUE THEN RETURN NULL;END IF;
  current_source:=read_scope_source(w,'memory',own_row.id);
  IF current_source IS NULL OR application_query_scope_admits_point(context->'bounds',current_source) IS NOT TRUE
   OR workflow_evidence_envelope_visible(w,current_source) IS NOT TRUE
   OR agent_visibility_allows(w,own_row.user_id,own_row.assistant_id) IS NOT TRUE THEN RETURN NULL;END IF;
  own_keys:=ARRAY(SELECT jsonb_array_elements_text(own#>'{resource,fields}'));
  IF NOT coalesce(to_jsonb(own_keys)<@(context->'read'),false) THEN RETURN NULL;END IF;
  own_policy:=application_memory_historical_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',own_row.id::text);
  own_mask:=NULL;
  IF own_policy->>'registered' IS DISTINCT FROM 'false' THEN
   IF own_policy->>'registered' IS DISTINCT FROM 'true' OR own_policy->>'held' IS DISTINCT FROM 'false'
    OR own_policy#>>'{metadata,recordVersion}' IS DISTINCT FROM own_row.scope_version::text THEN RETURN NULL;END IF;
   own_mask:=read_native_memory_historical_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',own_row.id::text,own_row.scope_version::text);
   IF own_mask IS NULL OR NOT coalesce(to_jsonb(own_keys)<@(own_mask->'readFields'),false) THEN RETURN NULL;END IF;
  END IF;
  fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('own',own,'policy',own_policy->'fingerprint','selectedRead',jsonb_build_object('fields',own_keys,'allowed',true),'source',current_source));
 END LOOP;
 FOR root IN SELECT value FROM jsonb_array_elements(proof->'roots') ORDER BY value::text LOOP
  IF proof->'qualifiedAnchors' @> jsonb_build_array(root)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f WHERE f->>'kind'=root->>'kind' AND f->>'id'=root->>'id' AND f->>'version'=root->>'version') THEN CONTINUE;END IF;
  IF root->>'kind'='application_query_domain' THEN
   -- A domain is an immutable query observation anchor, never a raw factual
   -- family. Its independently admitted observation rechecks the actual frozen
   -- selector/cohort and contributes the current domain/policy fingerprint.
   current_source:=NULL;
   FOR own IN SELECT to_jsonb(o) FROM jsonb_array_elements(proof->'independentNodes') n
    JOIN application_field_observations o ON n->>'kind'='application_field' AND o.workspace_id=w
     AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
    WHERE o.source_kind='application_query_domain' AND o.source_id=(root->>'id')::uuid AND o.source_version=root->>'version' ORDER BY o.resource_id,o.version,o.source_kind,o.source_id,o.source_version LOOP
    current_source:=read_admitted_application_field_snapshot(w,(own->>'resource_id')::uuid,own->>'version');
    IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM own->>'version' THEN RETURN NULL;END IF;
    fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('domain',root,'observation',own,'current',current_source));
   END LOOP;
   IF current_source IS NULL THEN RETURN NULL;END IF;
   CONTINUE;
  END IF;
  current_source:=CASE WHEN root->>'kind'='external_source' THEN external_source_snapshot(w,(root->>'id')::uuid)
   WHEN root->>'kind'='application_field' THEN read_admitted_application_field_snapshot(w,(root->>'id')::uuid,root->>'version')
   ELSE read_admitted_native_scope_snapshot(w,root->>'kind',(root->>'id')::uuid) END;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR root->>'kind' IN('external_source','application_field','session_context_revision') AND current_source->>'version' IS DISTINCT FROM root->>'version'
   THEN RETURN NULL;END IF;
  fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('root',root,'current',current_source));
 END LOOP;
 -- Selected values are read only after actual historical row/field restrictions.
 -- Full ancestry is checked by the existing pre-materialization/recorded hooks.
 FOREACH field IN ARRAY fields LOOP
  EXECUTE format('SELECT to_jsonb(%I) FROM public.memories WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',field)
   INTO selected_value USING w,i,v;
  values_json:=values_json||jsonb_build_object(field,selected_value);
 END LOOP;
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',v,'sourceKind','memory','sourceId',i,'sourceVersion',v,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory-history-v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory-history-current-v1','catalog',context#>'{policy,fingerprint}',
   'record',policy->'fingerprint','selectedRead',jsonb_build_object('fields',fields,'allowed',true),'values',values_json,'status',proof,'independent',fingerprints)),
  'references','[]'::jsonb,'historyStatus',proof);
END
$function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.application_memory_history_field_state(uuid,uuid,text,text[])'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_memory_history_field_state(uuid,uuid,text,text[])'::regprocedure) IS DISTINCT FROM '2fca209a91c878e3db0a31638acfb6af7e6f286aab094a92c7710744924859fa' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.read_native_memory_history_projection(uuid,uuid,text)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.read_native_memory_history_projection(w uuid, i uuid, v text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE fields text[];state jsonb;captured jsonb;
BEGIN
 fields:=ARRAY(SELECT field FROM unnest(application_memory_field_keys()) field ORDER BY field);
 state:=application_memory_history_field_state(w,i,v,fields);IF state IS NULL THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','memory',i,v,'history',v,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('row',captured->'values','source',jsonb_build_object('workspaceId',state#>'{source,workspaceId}','userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}',
  'resourceKind','memory','resourceId',i,'version',v),'sources',captured->'sources');
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.read_native_memory_history_projection(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_history_projection(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '81ef6dd811afa0286fdbce8027f027be11e7890de7d3a3c832cb62ef4754821b' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_canonical_ancestry_allowed(w uuid, k text, i uuid, v text, writing boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE nodes jsonb;node jsonb;dependency record;current jsonb;policy jsonb;mask jsonb;type_key text;
 resource application_field_resources;observation application_field_observations;envelope jsonb;expanded jsonb;current_roots jsonb;field_anchors jsonb:='[]';root jsonb;cursor_index integer:=0;
 history_envelope jsonb;history_proof jsonb;history_own boolean;history_state jsonb;history_version text;
 app_mode boolean:=nullif(current_setting('app.application_id',true),'') IS NOT NULL;
BEGIN
 IF NOT writing AND NOT app_mode THEN
  IF k='application_field' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
   IF FOUND AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory' AND resource.selection='history' THEN
    history_envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,'history',resource.selected_version,resource.fields);
    IF history_envelope IS NULL OR history_envelope#>>'{source,version}' IS DISTINCT FROM v THEN RETURN false;END IF;
   END IF;
  END IF;
  history_proof:=history_envelope#>'{state,historyStatus}';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) l;
 IF history_proof IS NOT NULL THEN
  FOR root IN SELECT value FROM jsonb_array_elements(history_proof->'roots') LOOP
   SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO expanded FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) l;
   SELECT coalesce(jsonb_agg(value),'[]') INTO expanded FROM jsonb_array_elements(expanded) value WHERE NOT nodes @> jsonb_build_array(value);
   nodes:=nodes||expanded;IF jsonb_array_length(nodes)>4096 THEN RETURN false;END IF;
  END LOOP;
 END IF;
 WHILE cursor_index<jsonb_array_length(nodes) LOOP
  node:=nodes->cursor_index;cursor_index:=cursor_index+1;
  IF node->>'kind'='application_field' THEN
   SELECT * INTO resource FROM application_field_resources r WHERE r.workspace_id=w AND r.id=(node->>'id')::uuid;
   IF NOT FOUND THEN RETURN false;END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=node->>'version';
   IF NOT FOUND THEN RETURN false;END IF;
   history_own:=history_proof IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(history_proof->'ownFields') f
    WHERE f->>'kind'='application_field' AND f->>'id'=resource.id::text AND f->>'version'=observation.version
     AND f->'resource'=to_jsonb(resource) AND f->'observation'=to_jsonb(observation));
   IF history_own THEN
    SELECT scope_version::text INTO history_version FROM memories WHERE workspace_id=w AND id=resource.resource_id;
    history_state:=application_memory_history_field_state(w,resource.resource_id,history_version,resource.fields);
    IF history_state IS NULL THEN RETURN false;END IF;
    current:=history_state->'source';
   ELSE
   current:=application_recorded_field_state_before_record_ancestry(w,resource.id,node->>'version',0);
   END IF;
   IF NOT history_own AND (current IS NULL OR current->>'held' IS DISTINCT FROM 'false') THEN RETURN false;END IF;
   IF NOT app_mode AND (application_reader_envelope_visible(w,observation.source_scope) IS NOT TRUE
    OR application_reader_envelope_visible(w,current) IS NOT TRUE) THEN RETURN false;END IF;
   -- Current target identities may differ from the immutable original targets.
   -- Read their metadata through the same selected-field canonical computation,
   -- then union their physical source lineage into this bounded worklist.
   IF history_own THEN
    envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,'history',history_version,resource.fields);
   ELSE
   envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
    resource.selection,resource.selected_version,resource.fields);
   END IF;
   IF envelope IS NULL THEN RETURN false;END IF;
   WITH RECURSIVE envelopes(value) AS (
    SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
   ), roots AS (
    SELECT jsonb_build_object('kind',e.value#>>'{state,sourceKind}','id',e.value#>>'{state,sourceId}','version',e.value#>>'{state,sourceVersion}') AS value
     FROM envelopes e WHERE scope_source_table(e.value#>>'{state,sourceKind}') IS NOT NULL OR e.value#>>'{state,sourceKind}'='entity_instance'
    UNION SELECT jsonb_build_object('kind','external_source','id',source->>'resourceId','version',source->>'version')
     FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'sources') source WHERE source->>'resourceKind'='external_source'
   ) SELECT coalesce(jsonb_agg(value),'[]') INTO current_roots FROM roots;
   field_anchors:=field_anchors||current_roots; FOR root IN SELECT value FROM jsonb_array_elements(current_roots) LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO expanded FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) l;
    SELECT coalesce(jsonb_agg(value),'[]') INTO expanded FROM jsonb_array_elements(expanded) value WHERE NOT nodes @> jsonb_build_array(value);
    nodes:=nodes||expanded;
    IF jsonb_array_length(nodes)>4096 THEN RETURN false;END IF;
   END LOOP;
  ELSIF history_proof IS NOT NULL AND node->>'kind'='memory' AND history_proof->'qualifiedAnchors' @> jsonb_build_array(node) THEN
   SELECT scope_version::text INTO history_version FROM memories WHERE workspace_id=w AND id=(node->>'id')::uuid;
   history_state:=application_memory_history_field_state(w,(node->>'id')::uuid,history_version,application_memory_field_keys());
   IF history_state IS NULL THEN RETURN false;END IF;
  ELSIF history_proof IS NOT NULL AND node->>'kind'='memory' AND history_proof->'independentNodes' @> jsonb_build_array(node) THEN
   current:=read_admitted_native_scope_snapshot(w,'memory',(node->>'id')::uuid);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  ELSIF node->>'kind'='external_source' THEN
   current:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM node->>'version'
    OR writing AND external_source_retention_allowed(w,(node->>'id')::uuid,node->>'version') IS NOT TRUE THEN RETURN false;END IF;
  -- The root's own canonical reader/writer owns row authority and refusal
  -- semantics. Field observations still recheck every native anchor.
  ELSIF scope_source_table(node->>'kind') IS NOT NULL AND NOT app_mode AND application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE THEN
   current:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind'='crm_event' AND current IS NULL OR current IS NOT NULL AND current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  END IF;
 END LOOP;
 IF app_mode THEN
  FOR node IN SELECT value FROM jsonb_array_elements(nodes) LOOP
   IF (scope_source_table(node->>'kind') IS NOT NULL OR node->>'kind'='entity_instance')
    AND application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(field_anchors) anchor WHERE anchor->>'kind'=node->>'kind' AND anchor->>'id'=node->>'id' AND anchor->>'version'=node->>'version') THEN
    current:=read_scope_source(w,node->>'kind',(node->>'id')::uuid);
    IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR application_native_source_scope_allowed(w,node->>'kind',(node->>'id')::uuid,current) IS NOT TRUE THEN RETURN false;END IF;
   END IF;
  END LOOP;
 END IF;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  -- Application source profiles keep their existing hold until their canonical
  -- native-source port is available. Never impersonate a member to lift it.
  IF (CASE WHEN app_mode THEN application_native_source_scope_allowed(w,dependency.resource_kind,dependency.resource_id,
   jsonb_build_object('workspaceId',w,'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids),'{}',CASE WHEN writing AND application_native_same_destination(w,k,i,dependency.resource_kind,dependency.resource_id) THEN 'patch' ELSE 'read' END) ELSE application_reader_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) END) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 IF app_mode THEN
  FOR dependency IN SELECT DISTINCT s.source_kind,s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
   ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
   ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
   WHERE d.workspace_id=w AND (scope_source_table(s.source_kind) IS NOT NULL OR s.source_kind='entity_instance') LOOP
    current:=read_scope_source(w,dependency.source_kind,dependency.source_id);
    IF application_native_source_scope_allowed(w,dependency.source_kind,dependency.source_id,current,
      application_native_source_fields(w,dependency.source_kind,dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
 END IF;
 FOR dependency IN SELECT DISTINCT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
  ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND s.source_kind='entity' LOOP
  SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  IF app_mode THEN
   current:=read_scope_source(w,'entity',dependency.source_id);
   IF application_native_source_scope_allowed(w,'entity',dependency.source_id,current,application_native_source_fields(w,'entity',dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
   CONTINUE;
  END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
    OR mask->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) IS DISTINCT FROM 'b15a27fe7a3ec273648b47c19dbaefe940b623a81a45c7761a35b8c2ebf52063' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_canonical_ancestry_from_admitted_root(w uuid, k text, i uuid, v text, writing boolean DEFAULT false, trusted_root jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE nodes jsonb;node jsonb;dependency record;current jsonb;policy jsonb;mask jsonb;type_key text;
 resource application_field_resources;observation application_field_observations;envelope jsonb;expanded jsonb;current_roots jsonb;field_anchors jsonb:='[]';root jsonb;cursor_index integer:=0;
 history_envelope jsonb;history_proof jsonb;history_own boolean;history_state jsonb;history_version text;
 app_mode boolean:=nullif(current_setting('app.application_id',true),'') IS NOT NULL;
BEGIN
 IF NOT writing AND NOT app_mode THEN
  IF k='application_field' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
   IF FOUND AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory' AND resource.selection='history' THEN
    history_envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,'history',resource.selected_version,resource.fields);
    IF history_envelope IS NULL OR history_envelope#>>'{source,version}' IS DISTINCT FROM v THEN RETURN false;END IF;
   END IF;
  ELSIF k='memory' AND trusted_root->>'kind'='memory' AND trusted_root->>'id'=i::text AND trusted_root->>'version'=v THEN
   envelope:=trusted_root->'envelope';
   IF envelope->'origin' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR envelope->>'typeKey' IS DISTINCT FROM 'memory' OR envelope->>'id' IS DISTINCT FROM i::text
    OR envelope->>'selection' IS DISTINCT FROM 'history' OR envelope->>'selectedVersion' IS DISTINCT FROM v THEN RETURN false;END IF;
   history_envelope:=application_compute_field_envelope(w,envelope->'origin','memory',i,'history',v,ARRAY(SELECT jsonb_array_elements_text(envelope->'fields')));
   IF history_envelope IS NULL OR history_envelope IS DISTINCT FROM envelope THEN RETURN false;END IF;
  END IF;
  history_proof:=history_envelope#>'{state,historyStatus}';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) l;
 IF history_proof IS NOT NULL THEN
  FOR root IN SELECT value FROM jsonb_array_elements(history_proof->'roots') LOOP
   SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO expanded FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) l;
   SELECT coalesce(jsonb_agg(value),'[]') INTO expanded FROM jsonb_array_elements(expanded) value WHERE NOT nodes @> jsonb_build_array(value);
   nodes:=nodes||expanded;IF jsonb_array_length(nodes)>4096 THEN RETURN false;END IF;
  END LOOP;
 END IF;
 WHILE cursor_index<jsonb_array_length(nodes) LOOP
  node:=nodes->cursor_index;cursor_index:=cursor_index+1;
  IF node->>'kind'='application_field' THEN
   SELECT * INTO resource FROM application_field_resources r WHERE r.workspace_id=w AND r.id=(node->>'id')::uuid;
   IF NOT FOUND THEN RETURN false;END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=node->>'version';
   IF NOT FOUND THEN RETURN false;END IF;
   history_own:=history_proof IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(history_proof->'ownFields') f
    WHERE f->>'kind'='application_field' AND f->>'id'=resource.id::text AND f->>'version'=observation.version
     AND f->'resource'=to_jsonb(resource) AND f->'observation'=to_jsonb(observation));
   IF history_own THEN
    SELECT scope_version::text INTO history_version FROM memories WHERE workspace_id=w AND id=resource.resource_id;
    history_state:=application_memory_history_field_state(w,resource.resource_id,history_version,resource.fields);
    IF history_state IS NULL THEN RETURN false;END IF;
    current:=history_state->'source';
   ELSE
   IF trusted_root IS NOT NULL AND k='application_field'
    AND node->>'kind'=k AND node->>'id'=i::text AND node->>'version'=v
    AND trusted_root->>'kind'=node->>'kind' AND trusted_root->>'id'=node->>'id' AND trusted_root->>'version'=node->>'version' THEN
    current:=trusted_root->'state';
    IF current IS NULL OR current->>'workspaceId' IS DISTINCT FROM w::text
     OR current->>'resourceKind' IS DISTINCT FROM 'application_field' OR current->>'resourceId' IS DISTINCT FROM resource.id::text
     OR current->>'held' IS DISTINCT FROM 'false' OR jsonb_typeof(current->'version') IS DISTINCT FROM 'string'
     OR length(current->>'version')=0 THEN RETURN false;END IF;
   ELSE
    current:=application_recorded_field_state_before_record_ancestry(w,resource.id,node->>'version',0);
   END IF;
   END IF;
   IF NOT history_own AND (current IS NULL OR current->>'held' IS DISTINCT FROM 'false') THEN RETURN false;END IF;
   IF NOT app_mode AND (application_reader_envelope_visible(w,observation.source_scope) IS NOT TRUE
    OR application_reader_envelope_visible(w,current) IS NOT TRUE) THEN RETURN false;END IF;
   -- Current target identities may differ from the immutable original targets.
   -- Read their metadata through the same selected-field canonical computation,
   -- then union their physical source lineage into this bounded worklist.
   IF history_own THEN
    envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,'history',history_version,resource.fields);
   ELSE
   IF trusted_root IS NOT NULL AND k='application_field'
    AND node->>'kind'=k AND node->>'id'=i::text AND node->>'version'=v
    AND trusted_root->>'kind'=node->>'kind' AND trusted_root->>'id'=node->>'id' AND trusted_root->>'version'=node->>'version' THEN
    envelope:=trusted_root->'envelope';
    IF envelope IS NULL OR jsonb_typeof(envelope) IS DISTINCT FROM 'object'
     OR envelope->>'resourceId' IS DISTINCT FROM resource.id::text OR envelope->>'identity' IS DISTINCT FROM resource.identity
     OR envelope->'origin' IS DISTINCT FROM resource.origin OR envelope->>'typeKey' IS DISTINCT FROM resource.type_key
     OR envelope->>'id' IS DISTINCT FROM resource.resource_id::text OR envelope->>'selection' IS DISTINCT FROM resource.selection
     OR envelope->>'selectedVersion' IS DISTINCT FROM resource.selected_version OR envelope->'fields' IS DISTINCT FROM to_jsonb(resource.fields)
     OR (envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))
     OR (envelope->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL)) IS DISTINCT FROM current THEN RETURN false;END IF;
   ELSE
    envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
     resource.selection,resource.selected_version,resource.fields);
   END IF;
   END IF;
   IF envelope IS NULL THEN RETURN false;END IF;
   WITH RECURSIVE envelopes(value) AS (
    SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
   ), roots AS (
    SELECT jsonb_build_object('kind',e.value#>>'{state,sourceKind}','id',e.value#>>'{state,sourceId}','version',e.value#>>'{state,sourceVersion}') AS value
     FROM envelopes e WHERE scope_source_table(e.value#>>'{state,sourceKind}') IS NOT NULL OR e.value#>>'{state,sourceKind}'='entity_instance'
    UNION SELECT jsonb_build_object('kind','external_source','id',source->>'resourceId','version',source->>'version')
     FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'sources') source WHERE source->>'resourceKind'='external_source'
   ) SELECT coalesce(jsonb_agg(value),'[]') INTO current_roots FROM roots;
   field_anchors:=field_anchors||current_roots; FOR root IN SELECT value FROM jsonb_array_elements(current_roots) LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO expanded FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) l;
    SELECT coalesce(jsonb_agg(value),'[]') INTO expanded FROM jsonb_array_elements(expanded) value WHERE NOT nodes @> jsonb_build_array(value);
    nodes:=nodes||expanded;
    IF jsonb_array_length(nodes)>4096 THEN RETURN false;END IF;
   END LOOP;
  ELSIF history_proof IS NOT NULL AND node->>'kind'='memory' AND history_proof->'qualifiedAnchors' @> jsonb_build_array(node) THEN
   SELECT scope_version::text INTO history_version FROM memories WHERE workspace_id=w AND id=(node->>'id')::uuid;
   history_state:=application_memory_history_field_state(w,(node->>'id')::uuid,history_version,application_memory_field_keys());
   IF history_state IS NULL THEN RETURN false;END IF;
  ELSIF history_proof IS NOT NULL AND node->>'kind'='memory' AND history_proof->'independentNodes' @> jsonb_build_array(node) THEN
   current:=read_admitted_native_scope_snapshot(w,'memory',(node->>'id')::uuid);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  ELSIF node->>'kind'='external_source' THEN
   current:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM node->>'version'
    OR writing AND external_source_retention_allowed(w,(node->>'id')::uuid,node->>'version') IS NOT TRUE THEN RETURN false;END IF;
  -- The root's own canonical reader/writer owns row authority and refusal
  -- semantics. Field observations still recheck every native anchor.
  ELSIF scope_source_table(node->>'kind') IS NOT NULL AND NOT app_mode AND application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE THEN
   current:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind'='crm_event' AND current IS NULL OR current IS NOT NULL AND current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  END IF;
 END LOOP;
 IF app_mode THEN
  FOR node IN SELECT value FROM jsonb_array_elements(nodes) LOOP
   IF (scope_source_table(node->>'kind') IS NOT NULL OR node->>'kind'='entity_instance')
    AND application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(field_anchors) anchor WHERE anchor->>'kind'=node->>'kind' AND anchor->>'id'=node->>'id' AND anchor->>'version'=node->>'version') THEN
    current:=read_scope_source(w,node->>'kind',(node->>'id')::uuid);
    IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR application_native_source_scope_allowed(w,node->>'kind',(node->>'id')::uuid,current) IS NOT TRUE THEN RETURN false;END IF;
   END IF;
  END LOOP;
 END IF;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  -- Application source profiles keep their existing hold until their canonical
  -- native-source port is available. Never impersonate a member to lift it.
  IF (CASE WHEN app_mode THEN application_native_source_scope_allowed(w,dependency.resource_kind,dependency.resource_id,
   jsonb_build_object('workspaceId',w,'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids),'{}',CASE WHEN writing AND application_native_same_destination(w,k,i,dependency.resource_kind,dependency.resource_id) THEN 'patch' ELSE 'read' END) ELSE application_reader_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) END) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 IF app_mode THEN
  FOR dependency IN SELECT DISTINCT s.source_kind,s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
   ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
   ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
   WHERE d.workspace_id=w AND (scope_source_table(s.source_kind) IS NOT NULL OR s.source_kind='entity_instance') LOOP
    current:=read_scope_source(w,dependency.source_kind,dependency.source_id);
    IF application_native_source_scope_allowed(w,dependency.source_kind,dependency.source_id,current,
      application_native_source_fields(w,dependency.source_kind,dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
 END IF;
 FOR dependency IN SELECT DISTINCT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
  ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND s.source_kind='entity' LOOP
  SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  IF app_mode THEN
   current:=read_scope_source(w,'entity',dependency.source_id);
   IF application_native_source_scope_allowed(w,'entity',dependency.source_id,current,application_native_source_fields(w,'entity',dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
   CONTINUE;
  END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
    OR mask->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure) IS DISTINCT FROM '41a30de9247f481b68c72d0be4e2c5831c790fa922e396b5dec0b63ba8812afb' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_field_envelope_ancestry_allowed(w uuid, envelope jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE root record;selected jsonb;
BEGIN
 IF envelope IS NULL THEN RETURN false;END IF;
 FOR selected IN WITH RECURSIVE envelopes(value) AS (
  SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
 ) SELECT value FROM envelopes LOOP
  IF selected->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb AND selected->>'typeKey'='memory' AND selected->>'selection'='history' THEN
   IF application_canonical_ancestry_from_admitted_root(w,'memory',(selected->>'id')::uuid,selected->>'selectedVersion',false,
    jsonb_build_object('kind','memory','id',selected->>'id','version',selected->>'selectedVersion','envelope',selected)) IS NOT TRUE THEN RETURN false;END IF;
  ELSE
   IF scope_source_table(selected#>>'{state,sourceKind}') IS NOT NULL
    AND application_canonical_ancestry_allowed(w,selected#>>'{state,sourceKind}',(selected#>>'{state,sourceId}')::uuid,selected#>>'{state,sourceVersion}') IS NOT TRUE THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure) IS DISTINCT FROM '79a23f4fc8d7047973d8b421b4de7285b014ce5c920cbbed75e15f17130f64fb' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.read_native_attended_memory_evidence(w uuid, kinds text[], ids uuid[], versions text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';cohort jsonb;
 history_resource application_field_resources;history_proof jsonb;history_source jsonb;label_scope jsonb;label_scopes jsonb:='[]';
 history_node record;history_field application_field_observations;history_dependency scope_derivations;history_observation application_field_observations;
BEGIN

 -- A direct current history root yields only purpose-qualified label metadata.
 -- It is never a whole-set admission and generic validators must continue.
 IF kinds=ARRAY['application_field']::text[] AND cardinality(ids)=1 AND cardinality(versions)=1 THEN
  SELECT * INTO history_resource FROM application_field_resources WHERE workspace_id=w AND id=ids[1]
   AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory' AND selection='history';
  IF FOUND THEN
 -- The subset preserves the same eligible attended native login profile.
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
   -- Discovery does not consume or admit external context/delivery. The
   -- generic path later validates this exact observation under fresh pins.
   SELECT * INTO history_observation FROM application_field_observations WHERE workspace_id=w AND resource_id=ids[1] AND version=versions[1];
   IF NOT FOUND OR history_observation.source_kind IS DISTINCT FROM 'memory'
    OR history_observation.source_id IS DISTINCT FROM history_resource.resource_id
    OR history_observation.source_version IS DISTINCT FROM history_resource.selected_version
    OR history_observation.record_version IS DISTINCT FROM history_resource.selected_version THEN
    RETURN '{"purpose":"memory_history","available":false}'::jsonb;END IF;
   history_source:=history_observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',history_observation.resource_id,'version',history_observation.version);
   history_proof:=application_memory_history_status(w,history_resource.resource_id,history_resource.selected_version);
   IF history_proof IS NULL THEN RETURN '{"purpose":"memory_history","available":false}'::jsonb;END IF;
   FOR history_node IN SELECT * FROM application_scope_lineage(w,kinds,ids,versions) LOOP
    IF history_node.kind='application_field' THEN
     SELECT * INTO history_field FROM application_field_observations WHERE workspace_id=w AND resource_id=history_node.id AND version=history_node.version;
     IF NOT FOUND THEN RETURN '{"purpose":"memory_history","available":false}'::jsonb;END IF;
     label_scopes:=label_scopes||jsonb_build_array(history_field.source_scope);
    END IF;
    IF scope_source_table(history_node.kind) IS NOT NULL THEN
     label_scope:=read_scope_source(w,history_node.kind,history_node.id);
     IF label_scope IS NOT NULL THEN label_scopes:=label_scopes||jsonb_build_array(jsonb_build_object('workspaceId',label_scope->'workspaceId',
      'userId',label_scope->'userId','assistantId',label_scope->'assistantId','sensitivity',label_scope->'sensitivity',
      'compartments',label_scope->'compartments','projectIds',label_scope->'projectIds'));END IF;
    END IF;
    FOR history_dependency IN SELECT * FROM scope_derivations WHERE workspace_id=w AND resource_kind=history_node.kind AND resource_id=history_node.id LOOP
     label_scopes:=label_scopes||jsonb_build_array(jsonb_build_object('workspaceId',w,'userId',history_dependency.user_id,
      'assistantId',history_dependency.assistant_id,'sensitivity',history_dependency.sensitivity,'compartments',history_dependency.compartments,'projectIds',history_dependency.project_ids));
    END LOOP;
    IF jsonb_array_length(label_scopes)>8192 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
   END LOOP;
   RETURN jsonb_build_object('purpose','memory_history','available',true,
    'root',history_source-ARRAY['held','validTo','retractedAt'],
    'scopes',(SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') FROM(SELECT DISTINCT value FROM jsonb_array_elements(label_scopes)) labels));
  END IF;
 END IF;
 -- Selected historical closures require the original complete validator.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND EXISTS(SELECT 1 FROM application_scope_lineage(w,kinds,ids,versions) l JOIN application_field_resources f
   ON l.kind='application_field' AND f.workspace_id=w AND f.id=l.id
   WHERE f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key='memory' AND f.selection='history') THEN RETURN NULL;END IF;
 cohort:=read_native_session_cohort_evidence(w,kinds,ids,versions,true);
 IF cohort IS NOT NULL THEN RETURN cohort;END IF;

 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  result:=application_session_eval_scope_current(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=nullif(result->'current','null'::jsonb);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 IF nodes IS DISTINCT FROM(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') FROM application_scope_lineage(w,kinds,ids,versions) n) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);

END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM '02b30a1673331cf5468fd09bd87db98a2e2a7cea528e5c4c5973b36a61ff7b2e' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc','prolang'] INTO metadata FROM pg_proc p WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.application_scope_source_edges(w uuid, k text, i uuid, v text)
 RETURNS TABLE(kind text, id uuid, version text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$DECLARE resource application_field_resources;observation application_field_observations;proof jsonb;
BEGIN
 RETURN QUERY SELECT e.kind,e.id,e.version FROM knowledge_version_source_edges(w,k,i,v) e;
 IF k IS DISTINCT FROM 'application_field' THEN RETURN;END IF;
 SELECT f.* INTO resource FROM application_field_resources f WHERE f.workspace_id=w AND f.id=i
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history';
 IF NOT FOUND THEN RETURN;END IF;
 SELECT o.* INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v;
 IF NOT FOUND OR observation.source_kind IS DISTINCT FROM 'memory' OR observation.source_id IS DISTINCT FROM resource.resource_id
  OR observation.record_version IS DISTINCT FROM resource.selected_version OR observation.source_version IS DISTINCT FROM resource.selected_version THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
 IF proof IS NULL THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT value->>'kind',(value->>'id')::uuid,value->>'version' FROM jsonb_array_elements(proof->'roots');
END
$function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc','prolang'] FROM pg_proc p WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure) IS DISTINCT FROM metadata OR (SELECT prolang FROM pg_proc WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure) IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure) IS DISTINCT FROM 'eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_body$ DECLARE metadata jsonb;BEGIN
 SELECT to_jsonb(p)-ARRAY['prosrc'] INTO metadata FROM pg_proc p WHERE oid='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure;
 EXECUTE $history_definition$CREATE OR REPLACE FUNCTION public.read_native_session_field_dependencies(w uuid, kinds text[], ids uuid[], versions text[])
 RETURNS TABLE(node_version text, source jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;position integer;
 resource application_field_resources;observation application_field_observations;proof jsonb;
BEGIN

 -- Each original root keeps its own purpose before union/deduplication.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND EXISTS(SELECT 1 FROM unnest(kinds,ids) r(kind,id) JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
    WHERE r.kind='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  FOR position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=ids[position]
    AND kinds[position]='application_field' AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory' AND selection='history';
   IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    CONTINUE;
   END IF;
   admitted:=read_admitted_application_field_snapshot(w,ids[position],versions[position]);
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[position] THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
   IF proof IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f
      WHERE f->>'id'=dependency.source->>'resourceId' AND f->>'version'=dependency.node_version)
     AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) r(kind,id,version) WHERE r.kind='application_field'
      AND r.id=(dependency.source->>'resourceId')::uuid AND r.version=dependency.node_version) THEN CONTINUE;END IF;
    admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
   END LOOP;
  END LOOP;
  RETURN;
 END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  SELECT origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key IN('session_message','session_message_annotation') INTO belongs
   FROM application_field_resources WHERE workspace_id=w AND id=(dependency.source->>'resourceId')::uuid;
  IF belongs IS DISTINCT FROM true THEN native_only:=false;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
 END LOOP;
 IF NOT native_only THEN RETURN QUERY SELECT * FROM read_admitted_application_field_dependencies(w,kinds,ids,versions);RETURN;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
  result:=application_session_eval_field(w,(item#>>'{source,resourceId}')::uuid,item->>'version',memo);memo:=coalesce(result->'memo',memo);admitted:=result->'value';
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(rows_json);
END $function$
$history_definition$;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc'] FROM pg_proc p WHERE oid='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure) IS DISTINCT FROM '1f84baac32c7dec94a4811302946eedb56431452ab1e5d91c6992b6f85535920' THEN RAISE EXCEPTION 'Memory history body metadata changed';END IF;
END $history_body$;
DO $history_pins$
DECLARE original text;changed text;definition text;metadata jsonb;pin record;old_literal text;new_literal text;fingerprint text;
 helper regprocedure:='public.application_memory_history_status(uuid,uuid,text)'::regprocedure;helper_metadata jsonb;canonical_owner oid;last_literal text;counted integer;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 changed:=original;
 FOR pin IN SELECT m[1]::oid AS function_oid,m[2] AS fingerprint FROM regexp_matches(original,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') m LOOP
  IF pin.function_oid=ANY(ARRAY['public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure::oid,
    'public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure::oid,
    'public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure::oid]) THEN
   SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO fingerprint FROM pg_proc p WHERE oid=pin.function_oid;
   old_literal:=format('(%s::oid,%L::text)',pin.function_oid,pin.fingerprint);new_literal:=format('(%s::oid,%L::text)',pin.function_oid,fingerprint);
   IF array_length(string_to_array(changed,old_literal),1)<>2 THEN RAISE EXCEPTION 'Memory history allocated pin not unique';END IF;
   changed:=replace(changed,old_literal,new_literal);
  END IF;
  last_literal:=format('(%s::oid,%L::text)',pin.function_oid,pin.fingerprint);
 END LOOP;
 SELECT count(*) INTO counted FROM regexp_matches(changed,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g');
 IF counted<>121 OR array_length(string_to_array(changed,'SELECT count(*)=121'),1)<>2 THEN RAISE EXCEPTION 'Memory history closed old pin shape changed';END IF;
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 SELECT to_jsonb(p) INTO helper_metadata FROM pg_proc p WHERE oid=helper;
 IF helper_metadata->>'proowner'<>canonical_owner::text OR helper_metadata->>'prosecdef'<>'true'
  OR helper_metadata->'proconfig' IS DISTINCT FROM to_jsonb(ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  OR encode(sha256(convert_to(helper_metadata->>'prosrc','UTF8')),'hex')<>'129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce'
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=helper),acldefault('f',canonical_owner))) a
    WHERE a.grantee<>canonical_owner OR a.grantor<>canonical_owner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
  RAISE EXCEPTION 'Memory history private status helper changed';END IF;
 fingerprint:=encode(sha256(convert_to(helper_metadata::text,'UTF8')),'hex');
 IF array_length(string_to_array(changed,last_literal),1)<>2 THEN RAISE EXCEPTION 'Memory history final old pin changed';END IF;
 changed:=replace(changed,last_literal,last_literal||','||format('(%s::oid,%L::text)',helper::oid,fingerprint));
 changed:=replace(changed,'SELECT count(*)=121','SELECT count(*)=122');
 EXECUTE replace(definition,original,changed);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM metadata
  OR application_memory_statement_helpers_current() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Memory history pin transition failed';END IF;
END $history_pins$;
COMMIT;
