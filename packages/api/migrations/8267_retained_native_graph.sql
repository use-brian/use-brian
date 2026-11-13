-- [COMP:api/native-chat-read-cost] Lossless retained native DAG acquisition.
-- Source templates: scripts/retained-native-reader/. Regenerate with build.mjs.
-- No historical message, annotation, policy or observation is rewritten.
BEGIN;
DO $retained_install$
DECLARE expected jsonb;actual pg_proc;prior jsonb:='{}';routine_signature text;old_row jsonb;guard_fingerprint text;changed integer;ok boolean;
 declared_roster text;declared_native_members constant text[]:=ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_field_digest(jsonb)','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_query_context(uuid)','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','assistant_placement_visible(uuid,uuid)','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_scope_source(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','scope_review_state_held(text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','sensitivity_rank(text)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[];
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 -- Authenticate the executable root before invoking its protected closed
 -- predecessor contract. Catalog hashes include metadata and effective ACLs.
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"native_turn_helpers_current()","language":"sql","volatility":"s","bodyTemplate":"803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_publication_contract()","language":"sql","volatility":"s","bodyTemplate":"publication-tables-8196","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_publication_contract","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)","body":"61cb2d845de95e9a20f585285f65000033599197dd6db5f75315aada2d23eaa7","language":"plpgsql","volatility":"v","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_prepare_publication","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_turn_requirements(uuid,jsonb)","body":"15bf5ffc81de78b0403eb30b2b00dd81f275b7691eada049243ebf8f6c4045b8","language":"plpgsql","volatility":"v","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_turn_requirements","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","roots"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_edges(uuid,jsonb)","body":"e5c5255989035650c73945e979581faeedb0135ce8f940b347f4f9df1d28735e","language":"sql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_edges","prorows":1000,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t","t","t"],"proargnames":["w","frontier","parent","child","edge_kind"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":["2950","3802","3802","3802","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_privacy_edges(uuid,jsonb)","body":"f1d8050be647b82a5fd1ebb051f62d2dd0c17067f4551264fb6ff3ce5de5f1d7","language":"sql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_privacy_edges","prorows":1000,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t","t"],"proargnames":["w","frontier","parent","child"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":["2950","3802","3802","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)","body":"7fd5badb63e7d68c82cfa4e266c2ff35caa83703b3f9f7c286e5283569b4fe2b","language":"plpgsql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_compact_domain","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","fields","memo","worklist_frame","completed_points"],"proargtypes":["2950","25","2950","1009","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)","body":"ad8339ec66f3144c25efe8fdc60aa1aa2825a550edc45e74ea016bd25d75a098","language":"plpgsql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_compact_envelope","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","selection","fields","memo","worklist_frame","completed_points"],"proargtypes":["2950","25","2950","25","1009","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)","body":"eb933c5f96df29237167f291cf3f01f41cf928eb7be0f981bc90764ba16313cc","language":"plpgsql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_compact_field","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","memo","worklist_frame","completed_points","completed_fields"],"proargtypes":["2950","2950","25","3802","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)","body":"7fb479137370a384bd417ee4515a742da8d1b87cd239648bffaac0e696293bdd","language":"plpgsql","volatility":"s","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_compact_scan","prorows":0,"pronargs":10,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","t","through","fields","bounds","visibility","memo","worklist_frame","completed_points"],"proargtypes":["2950","2950","25","23","1009","3802","3802","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]'::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual.oid IS NULL
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR (expected->>'signature' NOT IN('native_turn_helpers_current()','native_turn_publication_contract()')
    AND encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body')
   OR actual.proowner IS DISTINCT FROM owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR NOT actual.prosecdef
   OR actual.proisstrict OR actual.proparallel<>'u'
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR actual.provolatile IS DISTINCT FROM (expected->>'volatility')::"char"
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantee<>owner_id OR a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  THEN RAISE EXCEPTION 'retained_reader_predecessor_changed: %',expected->>'signature';END IF;
  IF expected->>'signature'='native_turn_helpers_current()' THEN
   -- 8246 enrolls the exact reviewed roster in the target collation. Only
   -- that single complete literal varies; every other body byte is pinned.
   IF expected->>'bodyTemplate' IS DISTINCT FROM '803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
    OR cardinality(declared_native_members)<>149
    OR (SELECT count(DISTINCT member) FROM unnest(declared_native_members) member)<>149
   THEN RAISE EXCEPTION 'retained_reader_native_roster_changed';END IF;
   SELECT 'ARRAY['||string_agg(quote_literal(member),',' ORDER BY member)||']::text[]' INTO declared_roster
    FROM unnest(declared_native_members) member;
   IF (length(actual.prosrc)-length(replace(actual.prosrc,declared_roster,'')))/length(declared_roster)<>1
    OR encode(sha256(convert_to(replace(actual.prosrc,declared_roster,'__ROSTER__'),'UTF8')),'hex') IS DISTINCT FROM expected->>'bodyTemplate'
   THEN RAISE EXCEPTION 'retained_reader_predecessor_changed: %',expected->>'signature';END IF;
  ELSIF expected->>'signature'='native_turn_publication_contract()'
   AND expected->>'bodyTemplate' IS DISTINCT FROM 'publication-tables-8196' THEN
   RAISE EXCEPTION 'retained_reader_publication_template_changed';
  END IF;
  prior:=prior||jsonb_build_object(expected->>'signature',to_jsonb(actual));
 END LOOP;
 -- This is known checksum-bound SQL, not prosrc obtained from the catalog.
 -- Its original strict table/default/FK/trigger checks precede reconstructing
 -- the complete comparator body with local catalog data and exactly two pins.
 EXECUTE $retained_publication_predecessor$DO $publication_tables$
DECLARE ids oid[]:=ARRAY['public.native_turn_frames'::regclass,'public.native_turn_publication_work'::regclass,'public.native_turn_publication_events'::regclass,'public.native_turn_publication_seals'::regclass,'public.native_turn_publication_impossible'::regclass,'public.native_turn_publication_debt'::regclass];actual jsonb;expected_body text;table_capture jsonb;pins text;
 -- pg_node_tree serializes by-value Datum slots at the server architecture
 -- width. Normalize only the complete canonical int4-one and boolean-false
 -- nodes from wasm32 to native64; every other AST/catalog byte remains exact.
 one32 constant text:='{CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 1 0 0 0 ]}';
 one64 constant text:='{CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 1 0 0 0 0 0 0 0 ]}';
 false32 constant text:='{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 ]}';
 false64 constant text:='{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]}';
BEGIN
 IF (SELECT count(*) FROM pg_class WHERE oid=ANY(ids))<>6 OR EXISTS(
  SELECT 1 FROM pg_class c WHERE c.oid=ANY(ids) AND (
   c.relowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR c.relnamespace<>'public'::regnamespace OR c.relkind<>'r' OR c.relpersistence<>'p'
   OR NOT c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.reloptions IS NOT NULL
   OR c.relam<>(SELECT oid FROM pg_am WHERE amname='heap')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable)))
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=ANY(ids) OR inhparent=ANY(ids))
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=ANY(ids))
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=ANY(ids))
 THEN RAISE EXCEPTION 'native_annotation_publication_table_changed';END IF;
 SELECT jsonb_object_agg(c.relname,(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,
  a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0)) INTO actual FROM pg_class c WHERE c.oid=ANY(ids);
 IF actual IS DISTINCT FROM '{"native_turn_frames":[[1,"workspace_id","2950",-1,true,"","",false,null],[2,"id","2950",-1,true,"","",false,null],[3,"session_id","2950",-1,true,"","",false,null],[4,"format","23",-1,true,"","",false,null],[5,"manifest_digest","25",-1,true,"","",false,null]],"native_turn_publication_work":[[1,"transaction_id","20",-1,true,"","",false,null],[2,"workspace_id","2950",-1,true,"","",false,null],[3,"frame_id","2950",-1,true,"","",false,null],[4,"session_id","2950",-1,true,"","",false,null],[5,"context","3802",-1,true,"","",false,null],[6,"original_sources","3802",-1,true,"","",false,null],[7,"prepared","3802",-1,true,"","",false,null],[8,"completion_ready","16",-1,true,"","",false,null]],"native_turn_publication_events":[[1,"transaction_id","20",-1,true,"","",false,null],[2,"frame_id","2950",-1,true,"","",false,null],[3,"event","3802",-1,true,"","",false,null],[4,"fired","16",-1,true,"","",false,null]],"native_turn_publication_seals":[[1,"transaction_id","20",-1,true,"","",false,null],[2,"frame_id","2950",-1,true,"","",false,null],[3,"outputs","3802",-1,true,"","",false,null]],"native_turn_publication_impossible":[[1,"id","2950",-1,true,"","",false,null]],"native_turn_publication_debt":[[1,"transaction_id","20",-1,true,"","",false,null],[2,"frame_id","2950",-1,true,"","",false,null]]}'::jsonb THEN RAISE EXCEPTION 'native_annotation_publication_columns_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(ids) AND a.attnum>0 AND
  (a.attndims<>0 OR a.attinhcount<>0 OR NOT a.attislocal OR a.attcollation IS DISTINCT FROM
   CASE WHEN a.atttypid='text'::regtype THEN 'pg_catalog."default"'::regcollation::oid ELSE 0::oid END))
 THEN RAISE EXCEPTION 'native_annotation_publication_column_semantics_changed';END IF;
 SELECT jsonb_object_agg(t.relname||':'||c.conname,(to_jsonb(c)-ARRAY['oid','conrelid','confrelid','conindid','connamespace'])
  ||jsonb_build_object('conbin',replace(replace(c.conbin::text,one32,one64),false32,false64),'refTable',r.relname)) INTO actual
 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid LEFT JOIN pg_class r ON r.oid=c.confrelid WHERE c.conrelid=ANY(ids);
 IF actual IS DISTINCT FROM '{"native_turn_frames:native_turn_frames_format_check":{"conbin":"{OPEXPR :opno 96 :opfuncid 65 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 0 :args ({VAR :varno 1 :varattno 4 :vartype 23 :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varreturningtype 0 :varnosyn 1 :varattnosyn 4 :location -1} {CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 1 0 0 0 0 0 0 0 ]}) :location -1}","conkey":[4],"confkey":null,"conname":"native_turn_frames_format_check","contype":"c","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_manifest_digest_check":{"conbin":"{OPEXPR :opno 641 :opfuncid 1254 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 5 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varreturningtype 0 :varnosyn 1 :varattnosyn 5 :location -1} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location -1 :constvalue 18 [ 72 0 0 0 94 91 97 45 102 48 45 57 93 123 54 52 125 36 ]}) :location -1}","conkey":[5],"confkey":null,"conname":"native_turn_frames_manifest_digest_check","contype":"c","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_workspace_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_frames_workspace_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_id_not_null":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_frames_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_session_id_not_null":{"conbin":null,"conkey":[3],"confkey":null,"conname":"native_turn_frames_session_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_format_not_null":{"conbin":null,"conkey":[4],"confkey":null,"conname":"native_turn_frames_format_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_manifest_digest_not_null":{"conbin":null,"conkey":[5],"confkey":null,"conname":"native_turn_frames_manifest_digest_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_pkey":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_frames_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_frames:native_turn_frames_workspace_id_fkey":{"conbin":null,"conkey":[1],"confkey":[1],"conname":"native_turn_frames_workspace_id_fkey","contype":"f","contypid":"0","conexclop":null,"conffeqop":["2972"],"conperiod":false,"conpfeqop":["2972"],"conppeqop":["2972"],"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":"c","confupdtype":"a","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":"s","confdelsetcols":null,"refTable":"workspaces"},"native_turn_frames:native_turn_frames_workspace_id_id_fkey":{"conbin":null,"conkey":[1,2],"confkey":[2,1],"conname":"native_turn_frames_workspace_id_id_fkey","contype":"f","contypid":"0","conexclop":null,"conffeqop":["2972","2972"],"conperiod":false,"conpfeqop":["2972","2972"],"conppeqop":["2972","2972"],"conislocal":true,"condeferred":true,"conenforced":true,"confdeltype":"a","confupdtype":"a","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":true,"confmatchtype":"s","confdelsetcols":null,"refTable":"session_context_scope_revisions"},"native_turn_publication_work:native_turn_publication_work_transaction_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_work_transaction_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_workspace_id_not_null":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_publication_work_workspace_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_frame_id_not_null":{"conbin":null,"conkey":[3],"confkey":null,"conname":"native_turn_publication_work_frame_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_session_id_not_null":{"conbin":null,"conkey":[4],"confkey":null,"conname":"native_turn_publication_work_session_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_context_not_null":{"conbin":null,"conkey":[5],"confkey":null,"conname":"native_turn_publication_work_context_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_original_sources_not_null":{"conbin":null,"conkey":[6],"confkey":null,"conname":"native_turn_publication_work_original_sources_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_prepared_not_null":{"conbin":null,"conkey":[7],"confkey":null,"conname":"native_turn_publication_work_prepared_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_completion_ready_not_null":{"conbin":null,"conkey":[8],"confkey":null,"conname":"native_turn_publication_work_completion_ready_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_work:native_turn_publication_work_pkey":{"conbin":null,"conkey":[1,3],"confkey":null,"conname":"native_turn_publication_work_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_events:native_turn_publication_events_transaction_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_events_transaction_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_events:native_turn_publication_events_frame_id_not_null":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_publication_events_frame_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_events:native_turn_publication_events_event_not_null":{"conbin":null,"conkey":[3],"confkey":null,"conname":"native_turn_publication_events_event_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_events:native_turn_publication_events_fired_not_null":{"conbin":null,"conkey":[4],"confkey":null,"conname":"native_turn_publication_events_fired_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_events:native_turn_publication_events_pkey":{"conbin":null,"conkey":[1,2,3],"confkey":null,"conname":"native_turn_publication_events_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_seals:native_turn_publication_seals_transaction_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_seals_transaction_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_seals:native_turn_publication_seals_frame_id_not_null":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_publication_seals_frame_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_seals:native_turn_publication_seals_outputs_not_null":{"conbin":null,"conkey":[3],"confkey":null,"conname":"native_turn_publication_seals_outputs_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_seals:native_turn_publication_seals_pkey":{"conbin":null,"conkey":[1,2],"confkey":null,"conname":"native_turn_publication_seals_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_impossible:native_turn_publication_impossible_check":{"conbin":"{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]}","conkey":null,"confkey":null,"conname":"native_turn_publication_impossible_check","contype":"c","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_impossible:native_turn_publication_impossible_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_impossible_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_impossible:native_turn_publication_impossible_pkey":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_impossible_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_debt:native_turn_publication_debt_transaction_id_not_null":{"conbin":null,"conkey":[1],"confkey":null,"conname":"native_turn_publication_debt_transaction_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_debt:native_turn_publication_debt_frame_id_not_null":{"conbin":null,"conkey":[2],"confkey":null,"conname":"native_turn_publication_debt_frame_id_not_null","contype":"n","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":false,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_debt:native_turn_publication_debt_pkey":{"conbin":null,"conkey":[1,2],"confkey":null,"conname":"native_turn_publication_debt_pkey","contype":"p","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":false,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":false,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_debt:application_field_derivation_dependencies":{"conbin":null,"conkey":[2],"confkey":[1],"conname":"application_field_derivation_dependencies","contype":"f","contypid":"0","conexclop":null,"conffeqop":["2972"],"conperiod":false,"conpfeqop":["2972"],"conppeqop":["2972"],"conislocal":true,"condeferred":true,"conenforced":true,"confdeltype":"a","confupdtype":"a","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":true,"confmatchtype":"s","confdelsetcols":null,"refTable":"native_turn_publication_impossible"},"native_turn_frames:native_turn_frame_pair":{"conbin":null,"conkey":null,"confkey":null,"conname":"native_turn_frame_pair","contype":"t","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":true,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":true,"confmatchtype":" ","confdelsetcols":null,"refTable":null},"native_turn_publication_seals:application_field_derivation_dependencies":{"conbin":null,"conkey":null,"confkey":null,"conname":"application_field_derivation_dependencies","contype":"t","contypid":"0","conexclop":null,"conffeqop":null,"conperiod":false,"conpfeqop":null,"conppeqop":null,"conislocal":true,"condeferred":true,"conenforced":true,"confdeltype":" ","confupdtype":" ","coninhcount":0,"conparentid":"0","connoinherit":true,"convalidated":true,"condeferrable":true,"confmatchtype":" ","confdelsetcols":null,"refTable":null}}'::jsonb
  OR EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=ANY(ids) AND (c.connamespace<>'public'::regnamespace
   OR c.confrelid<>0 AND NOT EXISTS(SELECT 1 FROM pg_class r WHERE r.oid=c.confrelid AND r.relnamespace='public'::regnamespace)
   OR c.contype NOT IN('p','f') AND c.conindid<>0
   OR c.contype IN('p','f') AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=c.conindid
    AND i.indrelid=CASE WHEN c.contype='p' THEN c.conrelid ELSE c.confrelid END
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indexprs IS NULL AND i.indpred IS NULL
    AND ARRAY(SELECT unnest(i.indkey))=CASE WHEN c.contype='p' THEN c.conkey ELSE c.confkey END)))
 THEN RAISE EXCEPTION 'native_annotation_publication_constraints_changed';END IF;
 -- Every table has only its declared primary index. Expressions, partial
 -- indexes, extra access methods or additional write-time code are unsupported.
 IF (SELECT count(*) FROM pg_index WHERE indrelid=ANY(ids))<>6 OR EXISTS(
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=ANY(ids) AND (
   NOT i.indisprimary OR NOT i.indisunique OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
   OR NOT i.indimmediate OR i.indisexclusion OR i.indnullsnotdistinct OR i.indnkeyatts<>i.indnatts
   OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR c.relam<>(SELECT oid FROM pg_am WHERE amname='btree')
   OR EXISTS(SELECT 1 FROM unnest(i.indcollation) v WHERE v<>0)
   OR EXISTS(SELECT 1 FROM unnest(i.indoption) v WHERE v<>0)
   OR EXISTS(SELECT 1 FROM unnest(i.indclass) WITH ORDINALITY op(class_id,position)
    LEFT JOIN pg_opclass cls ON cls.oid=op.class_id
    LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[(op.position-1)::integer]
    WHERE cls.opcnamespace IS DISTINCT FROM 'pg_catalog'::regnamespace OR NOT cls.opcdefault
     OR cls.opcmethod<>c.relam OR cls.opcintype IS DISTINCT FROM a.atttypid)))
 THEN RAISE EXCEPTION 'native_annotation_publication_indexes_changed';END IF;
 SELECT jsonb_object_agg(c.relname||':'||d.adnum,replace(d.adbin::text,false32,false64)) INTO actual
 FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid WHERE d.adrelid=ANY(ids);
 IF actual IS DISTINCT FROM '{"native_turn_publication_work:8":"{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]}","native_turn_publication_events:4":"{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]}"}'::jsonb THEN RAISE EXCEPTION 'native_annotation_publication_defaults_changed';END IF;
 SELECT jsonb_object_agg(c.relname||':'||t.tgname,(to_jsonb(t)-ARRAY['oid','tgrelid','tgfoid','tgconstraint'])
  ||jsonb_build_object('function',t.tgfoid::regprocedure::text,'constraint',con.conname)) INTO actual
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint
 WHERE t.tgrelid=ANY(ids) AND NOT t.tgisinternal;
 IF actual IS DISTINCT FROM '{"native_turn_frames:native_turn_frame_immutable":{"tgargs":"\\x","tgattr":[],"tgname":"native_turn_frame_immutable","tgqual":null,"tgtype":27,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":false,"function":"native_turn_frame_immutable()","constraint":null},"native_turn_frames:native_turn_frame_pair":{"tgargs":"\\x","tgattr":[],"tgname":"native_turn_frame_pair","tgqual":null,"tgtype":5,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":true,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":true,"function":"native_turn_validate_frame_pair()","constraint":"native_turn_frame_pair"},"native_turn_publication_debt:native_turn_completion_debt_guard":{"tgargs":"\\x","tgattr":[],"tgname":"native_turn_completion_debt_guard","tgqual":null,"tgtype":11,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":false,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":false,"function":"native_turn_guard_completion_debt()","constraint":null},"native_turn_publication_seals:application_field_derivation_dependencies":{"tgargs":"\\x","tgattr":[],"tgname":"application_field_derivation_dependencies","tgqual":null,"tgtype":5,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":true,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":true,"function":"native_turn_complete_publication()","constraint":"application_field_derivation_dependencies"}}'::jsonb OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE t.tgrelid=ANY(ids) AND NOT t.tgisinternal AND p.pronamespace<>'public'::regnamespace)
 THEN RAISE EXCEPTION 'native_annotation_publication_triggers_changed';END IF;
 -- Authenticate all FK trigger bindings, including referenced-side triggers.
 IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=ANY(ids) AND t.tgisinternal
   AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.oid=t.tgconstraint AND c.contype='f' AND c.conrelid=ANY(ids)))
  OR EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=ANY(ids) AND c.contype='f' AND (
   (SELECT count(*) FROM pg_trigger t WHERE t.tgconstraint=c.oid)<>4 OR EXISTS(
    SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=c.oid AND (
     NOT t.tgisinternal OR t.tgenabled<>'O' OR t.tgnargs<>0 OR t.tgargs<>''::bytea OR t.tgattr<>''::int2vector
     OR t.tgqual IS NOT NULL OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL OR t.tgparentid<>0
     OR t.tgconstrindid<>c.conindid OR t.tgconstrrelid<>CASE WHEN t.tgrelid=c.conrelid THEN c.confrelid ELSE c.conrelid END
     OR NOT(
      t.tgrelid=c.conrelid AND t.tgdeferrable=c.condeferrable AND t.tginitdeferred=c.condeferred
       AND (t.tgtype=5 AND t.tgfoid='pg_catalog."RI_FKey_check_ins"()'::regprocedure
        OR t.tgtype=17 AND t.tgfoid='pg_catalog."RI_FKey_check_upd"()'::regprocedure)
      OR t.tgrelid=c.confrelid AND (
       t.tgtype=17 AND t.tgfoid='pg_catalog."RI_FKey_noaction_upd"()'::regprocedure
        AND t.tgdeferrable=c.condeferrable AND t.tginitdeferred=c.condeferred
       OR t.tgtype=9 AND (c.confdeltype='c' AND t.tgfoid='pg_catalog."RI_FKey_cascade_del"()'::regprocedure AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        OR c.confdeltype='a' AND t.tgfoid='pg_catalog."RI_FKey_noaction_del"()'::regprocedure AND t.tgdeferrable=c.condeferrable AND t.tginitdeferred=c.condeferred)))))))
 THEN RAISE EXCEPTION 'native_annotation_publication_fk_trigger_changed';END IF;
 EXECUTE 'SELECT jsonb_build_object(
 ''tables'',(SELECT jsonb_agg(jsonb_build_object(''oid'',c.oid,''owner'',c.relowner,''kind'',c.relkind,''persistence'',c.relpersistence,''rls'',c.relrowsecurity,''forceRls'',c.relforcerowsecurity,''acl'',c.relacl) ORDER BY c.oid)
 FROM pg_class c WHERE c.oid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''columns'',(SELECT jsonb_agg(jsonb_build_array(attrelid,attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl) ORDER BY attrelid,attnum)
 FROM pg_attribute WHERE attnum>0 AND attrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''triggers'',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE tgrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''constraints'',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c WHERE conrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''rules'',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r WHERE ev_class=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''defaults'',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d WHERE adrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''policies'',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE polrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])))' INTO table_capture;
 expected_body:='SELECT (SELECT ('||'SELECT jsonb_build_object(
 ''tables'',(SELECT jsonb_agg(jsonb_build_object(''oid'',c.oid,''owner'',c.relowner,''kind'',c.relkind,''persistence'',c.relpersistence,''rls'',c.relrowsecurity,''forceRls'',c.relforcerowsecurity,''acl'',c.relacl) ORDER BY c.oid)
 FROM pg_class c WHERE c.oid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''columns'',(SELECT jsonb_agg(jsonb_build_array(attrelid,attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl) ORDER BY attrelid,attnum)
 FROM pg_attribute WHERE attnum>0 AND attrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''triggers'',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE tgrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''constraints'',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c WHERE conrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''rules'',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r WHERE ev_class=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''defaults'',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d WHERE adrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])),
 ''policies'',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE polrelid=ANY(ARRAY[''native_turn_frames''::regclass,''native_turn_publication_work''::regclass,''native_turn_publication_events''::regclass,''native_turn_publication_seals''::regclass,''native_turn_publication_impossible''::regclass,''native_turn_publication_debt''::regclass])))'||') IS NOT DISTINCT FROM '||quote_literal(table_capture::text)||'::jsonb) AND (SELECT count(*)=2 AND bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=expected.fingerprint) FROM (VALUES __PINS__) expected(id,fingerprint) JOIN pg_proc p ON p.oid=expected.id)';
 SELECT string_agg(format('(%L::regprocedure,%L::text)',p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.proname) INTO pins
 FROM pg_proc p WHERE p.oid=ANY(ARRAY['native_turn_complete_publication()'::regprocedure,'native_turn_helpers_current()'::regprocedure]);
 IF (SELECT prosrc FROM pg_proc WHERE oid='native_turn_publication_contract()'::regprocedure) IS DISTINCT FROM replace(expected_body,'__PINS__',pins) THEN
  SELECT string_agg(format('(%L::regprocedure,%L::text)',p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.proname DESC) INTO pins
  FROM pg_proc p WHERE p.oid=ANY(ARRAY['native_turn_complete_publication()'::regprocedure,'native_turn_helpers_current()'::regprocedure]);
  IF (SELECT prosrc FROM pg_proc WHERE oid='native_turn_publication_contract()'::regprocedure) IS DISTINCT FROM replace(expected_body,'__PINS__',pins)
  THEN RAISE EXCEPTION 'native_annotation_publication_contract_changed';END IF;
 END IF;
END $publication_tables$;$retained_publication_predecessor$;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_predecessor_contract_changed';END IF;
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||routine_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_predecessor_guard_changed: %',routine_signature;END IF;
 END LOOP;
 EXECUTE $registry$
  CREATE TABLE native_retained_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
  ALTER TABLE native_retained_contract_helpers ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON native_retained_contract_helpers FROM PUBLIC;
 $registry$;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON native_retained_contract_helpers FROM app_user;END IF;
 EXECUTE $new_guard$CREATE FUNCTION native_retained_helpers_current() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guard$
 SELECT native_turn_helpers_current() AND EXISTS(SELECT 1 FROM pg_class r WHERE r.oid='native_retained_contract_helpers'::regclass
  AND r.relkind='r' AND r.relpersistence='p' AND r.relrowsecurity AND NOT r.relforcerowsecurity
  AND r.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) a WHERE a.grantee<>r.relowner OR a.grantor<>r.relowner)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=r.oid)
  AND (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped)=ARRAY['signature','fingerprint']
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped AND (atttypid<>'text'::regtype OR NOT attnotnull)))
 AND array_agg(h.signature ORDER BY h.signature)=ARRAY['native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_helpers_current()','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_node_key(jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_privacy_edges(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)']::text[]
 AND bool_and(p.oid IS NOT NULL AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 FROM native_retained_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)
$guard$;$new_guard$;
 REVOKE ALL ON FUNCTION native_retained_helpers_current() FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION native_retained_helpers_current() FROM app_user;END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_fingerprint FROM pg_proc p
 WHERE p.oid='public.native_retained_helpers_current()'::regprocedure;
 EXECUTE replace($new_readers$-- Private completed canonical query envelopes; never shared between acquisitions.
CREATE FUNCTION native_retained_query_value(w uuid,frame jsonb,point_key text,slots jsonb,completed_values jsonb[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $cached$
DECLARE slot integer;
BEGIN
 IF frame->>'workspaceId' IS DISTINCT FROM w::text OR frame->>'closed' IS DISTINCT FROM 'true'
  OR NOT coalesce(slots ? point_key,false) OR jsonb_typeof(slots->point_key) IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
 slot:=(slots->>point_key)::integer;
 IF slot NOT BETWEEN 1 AND coalesce(cardinality(completed_values),0) THEN
  RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
 -- A present slot containing SQL NULL is the canonical completed-negative result.
 RETURN completed_values[slot];
END $cached$;
CREATE FUNCTION public.native_retained_cached_scan(w uuid,s uuid,t text,through integer,fields text[],bounds jsonb,visibility jsonb,memo jsonb,worklist_frame jsonb,completed_points jsonb,query_envelope_slots jsonb,query_envelope_values jsonb[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $compact$
DECLARE candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;query_fields text[];
BEGIN
 parent:=native_turn_parent(w,s,worklist_frame);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL OR fields IS NULL
  OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN '{}'::jsonb;END IF;
 SELECT count(*) INTO attempts FROM (SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through LIMIT 4097) bounded;
 IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 query_fields:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 WITH selected AS MATERIALIZED(
  SELECT m.id,m.sequence_num,native_retained_query_value(w,worklist_frame,jsonb_build_array(t,m.id,query_fields)::text,query_envelope_slots,query_envelope_values) point
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s AND m.sequence_num<=through
 ), admitted AS MATERIALIZED(
  SELECT * FROM selected q WHERE (q.point IS NULL OR q.point='null'::jsonb OR application_query_scope_admits_point(bounds,q.point->'source') IS NOT TRUE
   OR q.point#>>'{source,userId}' IS NOT NULL AND q.point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR q.point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (q.point#>>'{source,assistantId}'),false)) IS NOT TRUE
 ) SELECT
  coalesce(jsonb_agg(jsonb_build_object('id',a.id,'version',a.point#>'{state,recordVersion}') ORDER BY a.sequence_num,a.id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',a.id,'version',a.point#>'{state,recordVersion}','fields',fields,'source',a.point->'source') ORDER BY a.sequence_num,a.id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',a.id,'policy',a.point#>'{state,policyVersion}') ORDER BY a.sequence_num,a.id),'[]'),
  coalesce(jsonb_agg(a.point ORDER BY a.sequence_num,a.id),'[]')
 INTO candidates,points,policies,children FROM admitted a;
 RETURN jsonb_build_object('value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);
END $compact$;

CREATE FUNCTION public.native_retained_cached_domain(w uuid,t text,i uuid,fields text[],memo jsonb,worklist_frame jsonb,completed_points jsonb,query_envelope_slots jsonb,query_envelope_values jsonb[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $compact$
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;result jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;state jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN '{}'::jsonb;END IF;
 parent:=native_turn_parent(w,(frozen.domain->>'sessionId')::uuid,worklist_frame);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN '{}'::jsonb;END IF;
 current_bounds:=native_turn_session_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN '{}'::jsonb;END IF;
 result:=native_retained_cached_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values);
 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN '{}'::jsonb;END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'memo',memo,'children',result->'children');
END $compact$;

CREATE FUNCTION public.native_retained_cached_envelope(w uuid,t text,i uuid,selection text,fields text[],memo jsonb,worklist_frame jsonb,completed_points jsonb,query_envelope_slots jsonb,query_envelope_values jsonb[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $compact$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];point_key text;
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF selection IS DISTINCT FROM 'query_domain' OR t='memory' THEN
  RETURN native_turn_compact_envelope(w,t,i,selection,fields,memo,worklist_frame,completed_points);END IF;
 IF (t NOT IN('session_message','session_message_annotation') AND NOT(t='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) OR selection NOT IN('read','query','identity','query_domain') THEN RETURN '{}'::jsonb;END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN '{}'::jsonb;END IF;
 IF t='memory' THEN
  IF selection IS DISTINCT FROM 'query_domain' THEN RAISE EXCEPTION 'native_turn_family_unsupported' USING ERRCODE='PNT01';END IF;
  state:=native_turn_empty_memory_domain(w,i,keys,memo->'memoryStatement');
  IF state IS NULL THEN RETURN '{}'::jsonb;END IF;
  RETURN jsonb_build_object('value',native_turn_empty_memory_envelope(w,origin,t,i,selection,NULL,keys,0,state));
 END IF;
 IF selection='query_domain' THEN result:=native_retained_cached_domain(w,t,i,keys,memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values);children:=coalesce(result->'children','[]'::jsonb);
 ELSE
  point_key:=jsonb_build_array(t,i,keys)::text;
  IF worklist_frame->>'workspaceId' IS DISTINCT FROM w::text OR NOT coalesce(completed_points ? point_key,false) THEN
   RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
  result:=jsonb_build_object('value',completed_points->point_key);
 END IF;
 memo:=coalesce(result->'memo',memo);state:=result->'value';
 IF state IS NULL OR state='null'::jsonb THEN RETURN '{}'::jsonb;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 -- Metadata eligibility proved a closed graph with no independent sources.
 IF worklist_frame->>'workspaceId' IS DISTINCT FROM w::text OR worklist_frame->>'closed' IS DISTINCT FROM 'true'
  OR NOT coalesce(worklist_frame->'sourceKeys' ? ((state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion')),false)
 THEN RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (
  SELECT DISTINCT expanded.value FROM jsonb_array_elements(children) AS child_row(value)
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(child_row.value->'source')||coalesce(child_row.value->'sources','[]')) expanded(value)
 ) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN '{}'::jsonb;END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $compact$;

CREATE FUNCTION public.native_retained_cached_field(w uuid,i uuid,v text,memo jsonb,worklist_frame jsonb,completed_points jsonb,completed_fields jsonb,query_envelope_slots jsonb,query_envelope_values jsonb[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $compact$
DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';empty_capture jsonb;empty_lineage jsonb;empty_entry jsonb;
BEGIN
 IF scope_review_state_held('application_field',i) THEN RETURN NULL;END IF;
 SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;
 IF resource.selection IS DISTINCT FROM 'query_domain' OR resource.type_key='memory' THEN
  RETURN native_turn_compact_field(w,i,v,memo,worklist_frame,completed_points,completed_fields);END IF;
 IF resource.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (resource.type_key NOT IN('session_message','session_message_annotation') AND NOT(resource.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) THEN
  RAISE EXCEPTION 'native_turn_family_unsupported' USING ERRCODE='PNT01';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='session_messages'::regclass WHERE role.rolname=session_user
  AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN '{}'::jsonb;END IF;
 SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=i AND version=v;
 IF NOT FOUND OR resource.selected_version IS NOT NULL THEN RETURN '{}'::jsonb;END IF;

 result:=native_retained_cached_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values);
 memo:=coalesce(result->'memo',memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope->>'identity' IS DISTINCT FROM resource.identity OR (envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))
  OR workflow_evidence_envelope_visible(w,observation.source_scope) IS NOT TRUE OR workflow_evidence_envelope_visible(w,envelope->'source') IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
 FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=i AND version=v ORDER BY source_kind,source_id,source_version LOOP
  IF dependency.source_kind='application_field' THEN
   IF worklist_frame->>'workspaceId' IS DISTINCT FROM w::text OR NOT coalesce(completed_fields ? (dependency.source_id||':'||dependency.source_version),false) THEN
    RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
   current_source:=completed_fields->(dependency.source_id||':'||dependency.source_version);
  ELSE RAISE EXCEPTION 'native_turn_family_unsupported' USING ERRCODE='PNT01';END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR dependency.source_kind='external_source' AND current_source->>'version' IS DISTINCT FROM dependency.source_version THEN RETURN '{}'::jsonb;END IF;
 END LOOP;
 current_source:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 RETURN jsonb_build_object('value',current_source);
END $compact$;

-- [COMP:api/native-chat-read-cost] Private, lossless retained graph representation.
-- These helpers never admit a source. Every integer refers to one complete
-- canonical tuple in this invocation; semantic and recording graphs are separate.
CREATE FUNCTION native_retained_node_key(n jsonb, privacy boolean) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN privacy THEN
  CASE WHEN jsonb_typeof(n)='object' AND n-ARRAY['kind','id']='{}'::jsonb
   AND n ?& ARRAY['kind','id'] AND jsonb_typeof(n->'kind')='string'
   AND jsonb_typeof(n->'id')='string' THEN jsonb_build_array(n->'kind',n->'id')::text END
 ELSE CASE WHEN jsonb_typeof(n)='object' AND (
  n->>'tag'='source' AND n-ARRAY['tag','kind','id','version']='{}'::jsonb
   AND n ?& ARRAY['tag','kind','id','version']
   AND jsonb_typeof(n->'kind')='string' AND jsonb_typeof(n->'id')='string' AND jsonb_typeof(n->'version')='string'
  OR n->>'tag'='point' AND n-ARRAY['tag','kind','id','fields']='{}'::jsonb
   AND n ?& ARRAY['tag','kind','id','fields'] AND jsonb_typeof(n->'kind')='string'
   AND jsonb_typeof(n->'id')='string' AND jsonb_typeof(n->'fields')='array'
 ) THEN native_turn_key(n) END END
$$;

CREATE FUNCTION native_retained_graph_seed(nodes jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ordered jsonb;
BEGIN
 IF jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes)>4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE native_retained_node_key(n,privacy) IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n GROUP BY native_retained_node_key(n,privacy)
   HAVING count(DISTINCT n)>1) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(n ORDER BY native_retained_node_key(n,privacy)),'[]') INTO ordered
 FROM(SELECT DISTINCT value n FROM jsonb_array_elements(nodes)) q;
 RETURN jsonb_build_object('nodes',ordered,'edges','[]'::jsonb);
END $$;

CREATE FUNCTION native_retained_graph_append(graph jsonb, batch jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';added jsonb;packed jsonb;result jsonb;bad boolean;
BEGIN
 IF jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_typeof(graph->'edges') IS DISTINCT FROM 'array'
  OR jsonb_typeof(batch) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 -- Keys are interned once per frontier, using full tuple equality as well as
 -- key equality. A colliding or incomplete tuple is never silently merged.
 WITH known AS MATERIALIZED(SELECT value n,native_retained_node_key(value,privacy) k
  FROM jsonb_array_elements(nodes)), candidates AS MATERIALIZED(
  SELECT DISTINCT e->'child' n,native_retained_node_key(e->'child',privacy) k FROM jsonb_array_elements(batch) e
 ), fresh AS MATERIALIZED(SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM known old WHERE old.k=c.k))
 SELECT (SELECT coalesce(jsonb_agg(n ORDER BY k),'[]') FROM fresh),
  EXISTS(SELECT 1 FROM candidates c WHERE c.k IS NULL)
   OR EXISTS(SELECT 1 FROM candidates c JOIN known old USING(k) WHERE old.n IS DISTINCT FROM c.n)
   OR EXISTS(SELECT 1 FROM candidates GROUP BY k HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(batch) e WHERE
    NOT EXISTS(SELECT 1 FROM known old WHERE old.n=e->'parent')
    OR CASE WHEN privacy THEN e-ARRAY['parent','child']<>'{}'::jsonb
     ELSE e-ARRAY['parent','child','edge_kind']<>'{}'::jsonb
      OR e->>'edge_kind' IS NULL OR e->>'edge_kind'<>ALL(ARRAY['derivation','observation','observation_child',
       'predecessor','field_point','domain_candidate','point_body','point_head','revision_parent']) END)
 INTO added,bad;
 IF bad OR jsonb_array_length(nodes)+jsonb_array_length(added)>4096 THEN RETURN NULL;END IF;
 nodes:=nodes||added;
 WITH indexed AS MATERIALIZED(SELECT value n,ordinality::integer-1 i FROM jsonb_array_elements(nodes) WITH ORDINALITY),
 packed AS(SELECT DISTINCT jsonb_build_array(p.i,c.i,CASE WHEN privacy THEN 0 ELSE
  array_position(ARRAY['derivation','observation','observation_child','predecessor','field_point',
   'domain_candidate','point_body','point_head','revision_parent'],e->>'edge_kind') END) edge
  FROM jsonb_array_elements(batch) e JOIN indexed p ON p.n=e->'parent' JOIN indexed c ON c.n=e->'child')
 SELECT coalesce(jsonb_agg(edge ORDER BY edge),'[]') INTO packed FROM packed;
 result:=jsonb_build_object('nodes',nodes,'edges',(graph->'edges')||packed);
 -- A byte bound applies to the encoded representation, not the number of
 -- historical candidate relationships. It is an optimization eligibility gate.
 IF pg_column_size(result)>16777216 THEN RETURN NULL;END IF;
 RETURN result;
END $$;

CREATE FUNCTION native_retained_graph_edges(graph jsonb, privacy boolean)
RETURNS TABLE(parent jsonb,child jsonb,edge_kind text)
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';
BEGIN
 -- Bind the dictionary once. Extracting graph->'nodes' for every relationship
 -- copies a large JSON value repeatedly and defeats the packed representation.
 RETURN QUERY SELECT nodes->(e->>0)::integer,nodes->(e->>1)::integer,
  CASE WHEN privacy THEN NULL ELSE (ARRAY['derivation','observation','observation_child','predecessor',
   'field_point','domain_candidate','point_body','point_head','revision_parent'])[(e->>2)::integer] END
 FROM jsonb_array_elements(graph->'edges') e;
END
$$;

CREATE FUNCTION native_retained_expand_frontier(w uuid,graph jsonb,frontier jsonb,privacy boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE edge_row record;batch jsonb[]:='{}';
BEGIN
 -- Stream the original relational adjacency in bounded JSON batches. Its
 -- DISTINCT/tuplestore uses PostgreSQL's normal work-memory/spill controls;
 -- no unbounded array of expanded endpoint tuples is constructed here.
 IF privacy THEN
  FOR edge_row IN SELECT * FROM native_turn_privacy_edges(w,frontier) LOOP
   batch:=array_append(batch,to_jsonb(edge_row));
   IF cardinality(batch)=256 THEN
    graph:=native_retained_graph_append(graph,to_jsonb(batch),true);batch:='{}';
    IF graph IS NULL THEN RETURN NULL;END IF;
   END IF;
  END LOOP;
 ELSE
  FOR edge_row IN SELECT * FROM native_turn_edges(w,frontier) LOOP
   batch:=array_append(batch,to_jsonb(edge_row));
   IF cardinality(batch)=256 THEN
    graph:=native_retained_graph_append(graph,to_jsonb(batch),false);batch:='{}';
    IF graph IS NULL THEN RETURN NULL;END IF;
   END IF;
  END LOOP;
 END IF;
 IF cardinality(batch)>0 THEN graph:=native_retained_graph_append(graph,to_jsonb(batch),privacy);END IF;
 RETURN graph;
END $$;

CREATE FUNCTION native_retained_graph_topology(graph jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';keys text[];reverse_edges jsonb;degree_map jsonb;degrees integer[];
 queue integer[]:='{}';cursor_index integer:=1;item integer;parent_index integer;n integer;result jsonb;
BEGIN
 n:=jsonb_array_length(nodes);
 IF n=0 THEN RETURN '[]';END IF;
 IF n>4096 OR pg_column_size(graph)>16777216 OR EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'edges') e
  WHERE jsonb_typeof(e) IS DISTINCT FROM 'array' OR jsonb_array_length(e)<>3
   OR (e->>0)::integer NOT BETWEEN 0 AND n-1 OR (e->>1)::integer NOT BETWEEN 0 AND n-1
   OR (e->>2)::integer NOT BETWEEN 1 AND 9) THEN RETURN NULL;END IF;
 SELECT array_agg(native_retained_node_key(value,false) ORDER BY ordinality) INTO keys
 FROM jsonb_array_elements(nodes) WITH ORDINALITY;
 IF array_position(keys,NULL) IS NOT NULL OR cardinality(keys)<>(SELECT count(DISTINCT k) FROM unnest(keys) k) THEN RETURN NULL;END IF;
 WITH e AS MATERIALIZED(SELECT (value->>0)::integer+1 p,(value->>1)::integer+1 c FROM jsonb_array_elements(graph->'edges')),
 r AS(SELECT c,jsonb_agg(p) parents FROM e GROUP BY c),d AS(SELECT p,count(*) degree FROM e GROUP BY p)
 SELECT (SELECT jsonb_object_agg(c,parents) FROM r),(SELECT jsonb_object_agg(p,degree) FROM d)
 INTO reverse_edges,degree_map;
 SELECT array_agg(coalesce((degree_map->>i::text)::integer,0) ORDER BY i) INTO degrees FROM generate_series(1,n) i;
 FOR item IN 1..n LOOP IF degrees[item]=0 THEN queue:=array_append(queue,item);END IF;END LOOP;
 WHILE cursor_index<=cardinality(queue) LOOP
  item:=queue[cursor_index];cursor_index:=cursor_index+1;
  FOR parent_index IN SELECT value::integer FROM jsonb_array_elements_text(coalesce(reverse_edges->item::text,'[]')) LOOP
   degrees[parent_index]:=degrees[parent_index]-1;
   IF degrees[parent_index]=0 THEN queue:=array_append(queue,parent_index);END IF;
  END LOOP;
 END LOOP;
 IF cardinality(queue)<>n THEN RETURN NULL;END IF;
 SELECT jsonb_agg(keys[q.i] ORDER BY q.ord) INTO result FROM unnest(queue) WITH ORDINALITY q(i,ord);
 RETURN result;
END $$;

CREATE FUNCTION native_retained_graph_overlay(graph jsonb, batch jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';parents jsonb;bad boolean;result jsonb;
BEGIN
 -- A staged observation may introduce a new parent. Keep existing indices
 -- stable, then let the ordinary append intern every new child.
 WITH known AS MATERIALIZED(SELECT value n,native_retained_node_key(value,privacy) k FROM jsonb_array_elements(nodes)),
 candidates AS MATERIALIZED(SELECT DISTINCT e->'parent' n,native_retained_node_key(e->'parent',privacy) k FROM jsonb_array_elements(batch) e),
 fresh AS(SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM known old WHERE old.k=c.k))
 SELECT (SELECT coalesce(jsonb_agg(n ORDER BY k),'[]') FROM fresh),
  EXISTS(SELECT 1 FROM candidates c WHERE c.k IS NULL)
   OR EXISTS(SELECT 1 FROM candidates c JOIN known old USING(k) WHERE old.n IS DISTINCT FROM c.n)
   OR EXISTS(SELECT 1 FROM candidates GROUP BY k HAVING count(*)>1)
 INTO parents,bad;
 IF bad OR jsonb_array_length(nodes)+jsonb_array_length(parents)>4096 THEN RETURN NULL;END IF;
 result:=native_retained_graph_append(jsonb_set(graph,'{nodes}',nodes||parents),batch,privacy);
 IF result IS NULL THEN RETURN NULL;END IF;
 -- Reused canonical captures add no duplicate relationship to the plan.
 RETURN jsonb_set(result,'{edges}',(SELECT coalesce(jsonb_agg(edge ORDER BY edge),'[]')
  FROM(SELECT DISTINCT value edge FROM jsonb_array_elements(result->'edges')) unique_edges));
END $$;

CREATE FUNCTION native_retained_graph_equal(a jsonb,b jsonb,privacy boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 -- Dictionary order is private and may differ across independent snapshots.
 -- Compare the complete tuples and kind-bearing relations, never only hashes.
 SELECT NOT EXISTS(
  (SELECT value FROM jsonb_array_elements(a->'nodes') EXCEPT SELECT value FROM jsonb_array_elements(b->'nodes'))
  UNION ALL
  (SELECT value FROM jsonb_array_elements(b->'nodes') EXCEPT SELECT value FROM jsonb_array_elements(a->'nodes'))
 ) AND NOT EXISTS(
  (SELECT * FROM native_retained_graph_edges(a,privacy) EXCEPT SELECT * FROM native_retained_graph_edges(b,privacy))
  UNION ALL
  (SELECT * FROM native_retained_graph_edges(b,privacy) EXCEPT SELECT * FROM native_retained_graph_edges(a,privacy))
 )
$$;

-- [COMP:api/native-chat-read-cost] Typed projection of the pinned canonical edge formulas.
-- Parent indices retain the original tuple. Children become JSON only once per
-- distinct tuple, rather than once for every historical candidate relationship.
CREATE FUNCTION native_retained_edge_rows(w uuid,nodes jsonb[],frontier integer[],privacy boolean)
RETURNS TABLE(parent_index integer,child_tag text,child_kind text,child_id uuid,child_version text,child_fields jsonb,edge_kind integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE f AS MATERIALIZED(SELECT i parent_index,nodes[i+1] n FROM unnest(frontier) i),
 domain_selectors AS MATERIALIZED(
  SELECT f.parent_index,q.type_key,(q.domain->>'sessionId')::uuid session_id,
   (q.domain->>'throughSequence')::integer through_sequence,q.domain->'fields' selected_fields
  FROM f JOIN application_query_domains q ON n->>'tag'='source' AND n->>'kind'='application_query_domain'
   AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  WHERE NOT privacy AND q.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND q.type_key IN('session_message','session_message_annotation') AND q.domain->>'kind'='session_query_domain_v1'
 ), predecessors(root_index,id) AS (
  SELECT parent_index,wf.id FROM f JOIN workspace_files wf ON n->>'tag'='source' AND n->>'kind'='workspace_file'
   AND wf.workspace_id=w AND wf.id=(n->>'id')::uuid WHERE NOT privacy
  UNION SELECT p.root_index,wf.id FROM predecessors p JOIN workspace_files wf ON wf.workspace_id=w AND wf.superseded_by=p.id
 ), e AS (
  SELECT f.parent_index,'source'::text child_tag,s.source_kind child_kind,s.source_id child_id,s.source_version child_version,NULL::jsonb child_fields,1 edge_kind
  FROM f JOIN scope_derivations d ON n->>'tag'='source' AND d.workspace_id=w
   AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source',o.source_kind,o.source_id,o.source_version,NULL,2
  FROM f JOIN application_field_observations o ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version' WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source',s.source_kind,s.source_id,s.source_version,NULL,3
  FROM f JOIN application_field_observation_sources s ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid AND s.version=n->>'version' WHERE NOT privacy
  UNION ALL
  SELECT p.root_index,'source','workspace_file',p.id,f.n->>'version',NULL,4
  FROM predecessors p JOIN f ON f.parent_index=p.root_index WHERE p.id<>(f.n->>'id')::uuid
  UNION ALL
  SELECT f.parent_index,'point',r.type_key,r.resource_id,NULL,to_jsonb(r.fields),5
  FROM f JOIN application_field_resources r ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE NOT privacy AND r.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND r.type_key IN('session_message','session_message_annotation') AND r.selected_version IS NULL
   AND r.selection IN('read','query','identity')
  UNION ALL
  SELECT d.parent_index,'point',d.type_key,m.id,NULL,d.selected_fields,6
  FROM domain_selectors d JOIN session_messages m ON m.workspace_id=w AND m.session_id=d.session_id
   AND m.sequence_num<=d.through_sequence
  UNION ALL
  SELECT f.parent_index,'source','session_message',m.id,m.scope_version::text,NULL,7
  FROM f JOIN session_messages m ON n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source','session_context_revision',r.id,r.scope_version::text,NULL,8
  FROM f JOIN session_messages m ON n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=m.id
  JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
   AND r.session_id=m.session_id AND r.parent_kind='message_annotation' AND r.parent_id=m.id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source','session_message',m.id,m.scope_version::text,NULL,9
  FROM f JOIN session_context_scope_revisions r ON n->>'tag'='source' AND n->>'kind'='session_context_revision'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.parent_kind='message_annotation'
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=r.session_id AND m.id=r.parent_id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'privacy',s.source_kind,s.source_id,NULL,NULL,0
  FROM f JOIN scope_derivations d ON d.workspace_id=w AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy',o.source_kind,o.source_id,NULL,NULL,0
  FROM f JOIN application_field_observations o ON n->>'kind'='application_field' AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy',s.source_kind,s.source_id,NULL,NULL,0
  FROM f JOIN application_field_observation_sources s ON n->>'kind'='application_field' AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy','session_message',r.resource_id,NULL,NULL,0
  FROM f JOIN application_field_resources r ON n->>'kind'='application_field' AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE privacy AND r.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND r.type_key IN('session_message','session_message_annotation')
 ) SELECT DISTINCT parent_index,child_tag,child_kind,child_id,child_version,child_fields,edge_kind FROM e
$$;

CREATE FUNCTION native_retained_intern_frontier(w uuid,nodes jsonb[],frontier integer[],privacy boolean,edge_budget integer)
RETURNS TABLE(added_nodes jsonb[],packed_indices integer[],next_indices integer[],unavailable boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF cardinality(nodes)>4096 OR edge_budget NOT BETWEEN 0 AND 262144 OR array_position(frontier,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(frontier) i WHERE i NOT BETWEEN 0 AND cardinality(nodes)-1) THEN
  RETURN QUERY SELECT '{}'::jsonb[],'{}'::integer[],'{}'::integer[],true;RETURN;
 END IF;
 WITH e AS MATERIALIZED(SELECT * FROM native_retained_edge_rows(w,nodes,frontier,privacy)),
 descriptors AS MATERIALIZED(SELECT DISTINCT child_tag,child_kind,child_id,child_version,child_fields FROM e),
 children AS MATERIALIZED(SELECT d.*,CASE WHEN privacy THEN jsonb_build_object('kind',child_kind,'id',child_id)
  WHEN child_tag='source' THEN jsonb_build_object('tag','source','kind',child_kind,'id',child_id,'version',child_version)
  WHEN child_tag='point' THEN jsonb_build_object('tag','point','kind',child_kind,'id',child_id,'fields',child_fields) END node FROM descriptors d),
 known AS MATERIALIZED(SELECT value node,ordinality::integer-1 node_index FROM unnest(nodes) WITH ORDINALITY q(value,ordinality)),
 fresh AS MATERIALIZED(SELECT DISTINCT c.node FROM children c LEFT JOIN known k ON k.node=c.node WHERE k.node_index IS NULL ORDER BY c.node LIMIT 4097),
 numbered AS MATERIALIZED(SELECT node,cardinality(nodes)+(row_number() OVER(ORDER BY node))::integer-1 node_index FROM fresh),
 child_indices AS MATERIALIZED(SELECT c.*,coalesce(k.node_index,n.node_index) node_index FROM children c
  LEFT JOIN known k ON k.node=c.node LEFT JOIN numbered n ON n.node=c.node),
 resolved AS MATERIALIZED(SELECT e.parent_index,c.node_index,e.edge_kind FROM e LEFT JOIN child_indices c
  ON c.child_tag=e.child_tag AND c.child_kind=e.child_kind AND c.child_id=e.child_id
   AND coalesce(c.child_version,'')=coalesce(e.child_version,'')
   AND coalesce(c.child_fields,'null'::jsonb)=coalesce(e.child_fields,'null'::jsonb)),
 bounded AS MATERIALIZED(SELECT DISTINCT parent_index,node_index,edge_kind FROM resolved ORDER BY parent_index,node_index,edge_kind LIMIT edge_budget+1),
 ordered AS MATERIALIZED(SELECT *,row_number() OVER(ORDER BY parent_index,node_index,edge_kind) ord FROM bounded)
 SELECT (SELECT coalesce(array_agg(node ORDER BY node_index),'{}') FROM numbered),
  (SELECT coalesce(array_agg(v.value ORDER BY o.ord,v.slot),'{}') FROM ordered o
   CROSS JOIN LATERAL(VALUES(1,o.parent_index),(2,o.node_index),(3,o.edge_kind)) v(slot,value)),
  (SELECT coalesce(array_agg(node_index ORDER BY node_index),'{}') FROM numbered),
  cardinality(nodes)+(SELECT count(*) FROM fresh)>4096 OR (SELECT count(*) FROM bounded)>edge_budget
   OR EXISTS(SELECT 1 FROM fresh WHERE native_retained_node_key(node,privacy) IS NULL)
   OR EXISTS(SELECT 1 FROM resolved WHERE node_index IS NULL OR edge_kind IS NULL
    OR CASE WHEN privacy THEN edge_kind<>0 ELSE edge_kind NOT BETWEEN 1 AND 9 END)
 INTO added_nodes,packed_indices,next_indices,unavailable;
 RETURN NEXT;
END $$;

CREATE FUNCTION native_retained_graph_closure(w uuid,seeds jsonb,privacy boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE seeded jsonb;node_values jsonb[];frontier_indices integer[];frontier jsonb;batch record;
 indices integer[]:='{}';step integer:=0;node_bytes bigint;result jsonb;
BEGIN
 seeded:=native_retained_graph_seed(seeds,privacy);IF seeded IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(value ORDER BY ordinality),'{}'),coalesce(array_agg(ordinality::integer-1 ORDER BY ordinality),'{}'),
  coalesce(sum(pg_column_size(value)),0) INTO node_values,frontier_indices,node_bytes
 FROM jsonb_array_elements(seeded->'nodes') WITH ORDINALITY;
 WHILE cardinality(frontier_indices)>0 LOOP
  step:=step+1;IF step>4096 THEN RETURN NULL;END IF;
  IF NOT privacy THEN
   SELECT to_jsonb(array_agg(node_values[i+1])) INTO frontier FROM unnest(frontier_indices) i;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(frontier) n WHERE n->>'tag'='source'
    AND n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')) THEN RETURN NULL;END IF;
   IF EXISTS(WITH selectors AS MATERIALIZED(
    SELECT (q.domain->>'sessionId')::uuid session_id,(q.domain->>'throughSequence')::integer through_sequence
    FROM jsonb_array_elements(frontier) n JOIN application_query_domains q
     ON n->>'tag'='source' AND n->>'kind'='application_query_domain' AND q.workspace_id=w AND q.id=(n->>'id')::uuid
    WHERE q.type_key IN('session_message','session_message_annotation'))
    SELECT 1 FROM selectors d WHERE
     (SELECT count(*) FROM(SELECT 1 FROM session_messages m WHERE m.workspace_id=w
      AND m.session_id=d.session_id AND m.sequence_num<=d.through_sequence LIMIT 4097) bounded)>4096) THEN RETURN NULL;END IF;
  END IF;
  SELECT * INTO STRICT batch FROM native_retained_intern_frontier(w,node_values,frontier_indices,privacy,262144-cardinality(indices)/3);
  IF batch.unavailable IS NOT FALSE THEN RETURN NULL;END IF;
  node_values:=node_values||batch.added_nodes;indices:=indices||batch.packed_indices;frontier_indices:=batch.next_indices;
  node_bytes:=node_bytes+pg_column_size(batch.added_nodes);
  IF node_bytes>16777216 THEN RETURN NULL;END IF;
 END LOOP;
 SELECT jsonb_build_object('nodes',to_jsonb(node_values),'edges',coalesce(jsonb_agg(
  jsonb_build_array(indices[n*3+1],indices[n*3+2],indices[n*3+3]) ORDER BY n),'[]'))
 INTO result FROM generate_series(0,cardinality(indices)/3-1) n;
 IF pg_column_size(result)>16777216 THEN RETURN NULL;END IF;
 RETURN result;
END $$;

-- [COMP:api/native-chat-read-cost] Complete canonical metadata with packed adjacency.
CREATE FUNCTION public.native_retained_metadata(w uuid, roots jsonb, selectors jsonb, discovery boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 nodes jsonb;frontier jsonb;next_nodes jsonb;edges jsonb:='[]';batch jsonb;
 privacy_nodes jsonb;privacy_frontier jsonb;privacy_edges jsonb:='[]';privacy_parents jsonb;recording_epochs jsonb;
 native_metadata jsonb;field_metadata jsonb;domains jsonb;candidates jsonb;point_metadata jsonb;parents jsonb;
 derivations jsonb;context jsonb;locks jsonb;witness jsonb;remaining jsonb;ready jsonb;order_json jsonb:='[]';
 reasons text[]:='{}';step integer:=0;counts jsonb;media_node jsonb;media_lineage jsonb;media_graph jsonb;
 graph jsonb;privacy_graph jsonb;prior_nodes integer;
BEGIN
 -- These are eligibility/profile gates only, not all actor permissions.
 IF w IS NULL OR actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.programmatic_candidate_source',true),'') IS NOT NULL
  OR nullif(current_setting('app.workflow_schedule_review',true),'') IS NOT NULL
  OR nullif(current_setting('app.system_bypass',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text
  OR acting IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistants WHERE workspace_id=w AND id=acting)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','profile_unavailable');END IF;
 IF (SELECT count(p.oid)=15 AND bool_and(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=m.digest)
  FROM (VALUES ('application_scope_source_edges(uuid,text,uuid,text)','eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077'),
('knowledge_version_source_edges(uuid,text,uuid,text)','f4deb0d7b7ef41db5dc1d2fedabcef545c836b9f8a78f48d55a2c7413e62f1cf'),
('application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','23d72c938e15ccb1877e6deabc9b75cd44c92f2539b0afd1c0456517086d6a03'),
('application_native_source_edges_dispatch(uuid,text,uuid,text)','e8df0ffdc3f459a5c4bbf6be0703d087ca4e02ad8bf04ce0b0e536dbb82566ca'),
('scope_source_ancestors(uuid,text,uuid)','cabe0f65f8e31b0123ebe2328d72f314ee1b82795cfa5cf66deb57c792384282'),
('scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
('scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
('scope_source_ancestors_before_browser_profile(uuid,text,uuid)','6b775f0025f9dc1be7fb3d6f230d7b0dec53dcb68de66e28c2f0c4326c5f9a48'),
('recording_source_read_allowed(uuid,text,uuid)','8a584e976f5e93fa624fc4e5442a5e62f7cd8efb90317f85d7168d03b1b6bcc1'),
('session_recording_read_allowed(uuid)','d23352b30977749dd2dad03504c1dab5cdeb9aa1b2ef11fc79701bd8714e1886'),
('application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','2d8a9fdc382de4994bddd451dfbf0551e4ed53e6d0c75d7f06065584237700d2'),
('application_session_eval_domain(uuid,text,uuid,text[],jsonb)','47d45fe98cde529fd5bf6c01b9f3fc91cf891219aa94a0ade096fd290053911b'),
('application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','8f01ca980231ecab5963092178ec34d322986d6cd3451b2a037bc721721bae18'),
('application_session_query_parent(uuid,uuid)','85393998bba4fe1af647bbfaade0ae59e364081e4bbea4de1e57ccaf86cbd2e1'),
('application_memory_field_keys()','121516e1933584c3a2137363ff50204139876471c7b9b3e82ac736279c04c58c')) m(signature,digest) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(m.signature)) IS NOT TRUE
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','source_contract_changed');END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r-ARRAY['kind','id','version']<>'{}'
    OR r->>'kind' NOT IN('application_field','session_message','session_context_revision','workspace_file') OR NOT r ?& ARRAY['kind','id','version'] OR jsonb_typeof(r->'kind')<>'string' OR jsonb_typeof(r->'id')<>'string'
    OR jsonb_typeof(r->'version')<>'string' OR length(r->>'version') NOT BETWEEN 1 AND 256)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','invalid_roots');END IF;
 SELECT coalesce(jsonb_agg(n ORDER BY public.native_turn_key(n)),'[]') INTO nodes
 FROM(SELECT DISTINCT value||'{"tag":"source"}'::jsonb n FROM jsonb_array_elements(roots)) q;
 -- Selectors are server-owned query metadata, never evidence or permission.
 IF jsonb_typeof(selectors) IS DISTINCT FROM 'array' OR jsonb_array_length(selectors)>2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(selectors) q WHERE jsonb_typeof(q) IS DISTINCT FROM 'object'
   OR q-ARRAY['type','sessionId','through']<>'{}' OR NOT q ?& ARRAY['type','sessionId','through']
   OR jsonb_typeof(q->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(q->'sessionId') IS DISTINCT FROM 'string'
   OR q->>'type' NOT IN('session_message','session_message_annotation') OR jsonb_typeof(q->'through') IS DISTINCT FROM 'number'
   OR (q->>'through')::numeric IS DISTINCT FROM (q->>'through')::integer::numeric OR (q->>'through')::integer<0
   OR (q->>'sessionId')::uuid IS NULL)
  OR (SELECT count(*) FROM jsonb_array_elements(selectors))<>(SELECT count(DISTINCT q->>'type') FROM jsonb_array_elements(selectors) q)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'reason','selector_shape');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(selectors) q WHERE (SELECT count(*) FROM (
  SELECT 1 FROM session_messages m WHERE m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid
   AND m.sequence_num<=(q->>'through')::integer LIMIT 4097) bounded)>4096)
 THEN RETURN jsonb_build_object('eligibleMetadata',false,'reason','selector_candidate_bound');END IF;
 SELECT jsonb_agg(n ORDER BY native_turn_key(n)) INTO nodes FROM (
  SELECT value n FROM jsonb_array_elements(nodes)
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,
   'fields',(SELECT jsonb_agg(k ORDER BY k) FROM unnest(application_session_field_keys(q->>'type')) k))
   FROM jsonb_array_elements(selectors) q JOIN session_messages m
    ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) complete_candidates;
 graph:=native_retained_graph_closure(w,nodes,false);
 IF graph IS NULL THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','semantic_graph_unavailable');END IF;
 nodes:=graph->'nodes';edges:=graph->'edges';

 -- Include every physical candidate source, not only the original evidence.
 SELECT coalesce(jsonb_agg(n ORDER BY n::text),'[]') INTO privacy_nodes FROM(
  SELECT DISTINCT jsonb_build_object('kind',CASE WHEN n->>'tag'='point' THEN 'session_message' ELSE n->>'kind' END,'id',n->'id') n
  FROM jsonb_array_elements(nodes) n
 ) q;
 -- Canonical point-field identities are payload-independent. Existing
 -- observations may retain older annotation heads, so close their complete
 -- versionless privacy ancestry before selecting the current head's payload.
 -- Use the same physical query-resource universe before and after writes:
 -- current selectors plus every stored domain candidate, including missing and
 -- excluded heads. Plain read/identity field points do not add query resources.
 WITH query_points AS MATERIALIZED(
  SELECT e.child point FROM native_retained_graph_edges(graph,false) e WHERE e.edge_kind='domain_candidate'
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,
   'fields',(SELECT jsonb_agg(k ORDER BY k) FROM unnest(application_session_field_keys(q->>'type')) k))
   FROM jsonb_array_elements(selectors) q JOIN session_messages m
    ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) SELECT jsonb_agg(n ORDER BY n::text) INTO privacy_nodes FROM (
  SELECT value n FROM jsonb_array_elements(privacy_nodes)
  UNION SELECT jsonb_build_object('kind','application_field','id',application_field_resource_uuid(application_field_digest(
   jsonb_build_object('workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,
    'typeKey',point->>'kind','id',(point->>'id')::uuid,'selection','query','selectedVersion',NULL,'fields',point->'fields',
    'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',point->>'kind','fields',point->'fields'))))))
   FROM query_points
 ) privacy_seeds;
 privacy_graph:=native_retained_graph_closure(w,privacy_nodes,true);
 IF privacy_graph IS NULL THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','privacy_graph_unavailable');END IF;
 privacy_nodes:=privacy_graph->'nodes';privacy_edges:=privacy_graph->'edges';

 -- Exact six parent-resolution families, preserving a missing nonnull parent.
 WITH n AS MATERIALIZED(SELECT value FROM jsonb_array_elements(privacy_nodes)), p AS (
 SELECT value node,s.id session_id FROM n JOIN sessions s ON value->>'kind'='session' AND s.workspace_id=w AND s.id=(value->>'id')::uuid
 UNION SELECT value,m.session_id FROM n JOIN session_messages m ON value->>'kind'='session_message' AND m.id=(value->>'id')::uuid
  JOIN sessions s ON s.id=m.session_id AND s.workspace_id=w
 UNION SELECT value,r.session_id FROM n JOIN session_context_scope_revisions r ON value->>'kind'='session_context_revision' AND r.workspace_id=w AND r.id=(value->>'id')::uuid
 UNION SELECT value,s.session_id FROM n JOIN session_state s ON value->>'kind'='session_state' AND s.id=(value->>'id')::uuid
 UNION SELECT value,e.session_id FROM n JOIN episodic_memories e ON value->>'kind'='episodic_memory' AND e.id=(value->>'id')::uuid
 UNION SELECT value,e.session_id FROM n JOIN analytics_events e ON value->>'kind'='feedback_event' AND e.id=(value->>'id')::uuid
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',p.node,'sessionId',p.session_id,'exists',s.id IS NOT NULL,
  'held',s.recording_privacy_held,'recordingRevision',s.recording_revision,
  'legacyRecording',s.channel_type='telegram' AND s.anchor_kind='channel' AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$') ORDER BY p.node::text,p.session_id),'[]')
 INTO privacy_parents FROM p LEFT JOIN sessions s ON s.id=p.session_id;
 -- This is optimization eligibility metadata, not actor or source admission.
 -- Every recording parent in the complete privacy closure must be an exact
 -- active Work epoch. Held, Personal and unreviewed legacy parents still fall back.
 WITH parent_ids AS(SELECT DISTINCT (p->>'sessionId')::uuid id FROM jsonb_array_elements(privacy_parents) p
  WHERE p->>'sessionId' IS NOT NULL), certificates AS(
 SELECT s.id,jsonb_build_object('eligible',coalesce(
  s.workspace_id=w AND NOT s.recording_privacy_held AND s.visibility='workspace'
  AND s.channel_type='telegram' AND s.anchor_kind='channel' AND s.anchor_ref=s.channel_id
  AND s.recording_revision IS NOT NULL AND s.recording_policy_id=policy.id
  AND policy.workspace_id=w AND policy.session_id=s.id AND policy.revision=s.recording_revision
  AND policy.enabled AND policy.destination='workspace' AND policy.project_id IS NOT DISTINCT FROM s.context_project_id
  AND policy.conversation_id=s.channel_id AND policy.owner_user_id=s.user_id
  AND ci.id=policy.integration_id AND ci.status='active' AND ci.channel_type='telegram'
  AND ci.bot_user_id=policy.bot_id AND ci.recording_owner_user_id=policy.owner_user_id
  AND c.id=ci.channel_id AND c.workspace_id=w AND c.status='active' AND c.channel_type='telegram'
  AND owner_member.user_id=policy.owner_user_id AND a.id=s.assistant_id AND a.workspace_id=w
  AND routing.assistant_id=s.assistant_id AND audience.allowed
  AND (SELECT count(*) FROM channel_assistants same_route WHERE same_route.channel_id=c.id
   AND same_route.external_surface_id IS NOT DISTINCT FROM routing.external_surface_id)=1
  AND (policy.project_id IS NULL OR project.id=policy.project_id AND project.workspace_id=w
   AND project.status='active' AND project_scope.status='active'
   AND workspace.department_read_v2 AND workspace.project_shared_spaces
   AND project_member_live(policy.project_id,'user',policy.owner_user_id)
   AND project_member_live(policy.project_id,'assistant',s.assistant_id)),false),
  'policy',to_jsonb(policy),
  'integration',jsonb_build_object('id',ci.id,'channelId',ci.channel_id,'channelType',ci.channel_type,
   'status',ci.status,'botId',ci.bot_user_id,'recorderId',ci.recording_owner_user_id),
  'channel',jsonb_build_object('id',c.id,'workspaceId',c.workspace_id,'channelType',c.channel_type,
   'status',c.status,'clearance',c.clearance,'capabilities',c.enabled_capabilities),
  'owner',jsonb_build_object('userId',owner_member.user_id,'role',owner_member.role,
   'clearance',owner_member.clearance,'compartments',owner_member.compartments),
  'assistant',jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'clearance',a.clearance,
   'compartments',a.compartments,'departmentId',a.placement_department_id),
  'routing',jsonb_build_object('id',routing.id,'channelId',routing.channel_id,
   'assistantId',routing.assistant_id,'surfaceId',routing.external_surface_id),
  'audiences',audience.bindings,
  'project',jsonb_build_object('id',project.id,'workspaceId',project.workspace_id,'status',project.status,
   'sharedStatus',project_scope.status,'enabled',workspace.project_shared_spaces AND workspace.department_read_v2,
   'recorderMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'user',policy.owner_user_id) ELSE NULL END,
   'assistantMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'assistant',s.assistant_id) ELSE NULL END)) certificate
 FROM parent_ids ids JOIN sessions s ON s.id=ids.id
 LEFT JOIN channel_recording_policies policy ON policy.id=s.recording_policy_id
 LEFT JOIN channel_integrations ci ON ci.id=policy.integration_id
 LEFT JOIN channels c ON c.id=ci.channel_id
 LEFT JOIN workspace_members owner_member ON owner_member.workspace_id=w AND owner_member.user_id=policy.owner_user_id
 LEFT JOIN assistants a ON a.id=s.assistant_id
 LEFT JOIN workspaces workspace ON workspace.id=w
 LEFT JOIN workspace_projects project ON project.id=policy.project_id
 LEFT JOIN project_shared_scopes project_scope ON project_scope.project_id=policy.project_id
 LEFT JOIN LATERAL(SELECT ca.id,ca.channel_id,ca.assistant_id,ca.external_surface_id FROM channel_assistants ca
  WHERE ca.channel_id=c.id AND(ca.external_surface_id IN(s.channel_id,split_part(s.channel_id,':',1)) OR ca.external_surface_id IS NULL)
  ORDER BY CASE WHEN ca.external_surface_id=s.channel_id THEN 1 WHEN ca.external_surface_id=split_part(s.channel_id,':',1) THEN 2 ELSE 3 END LIMIT 1) routing ON true
 LEFT JOIN LATERAL(
  -- Match the canonical provider-group audience: every active bot's exact
  -- topic AND parent approval participates, with the same company-wide rule.
  SELECT count(*)>0 AND coalesce(bool_and(coalesce(
   binding->'version'='1'::jsonb AND binding->>'audienceType'='group' AND binding->>'recipientUserId' IS NULL
   AND (binding->'companyWide' IS NULL OR jsonb_typeof(binding->'companyWide')='boolean')
   AND binding->>'clearance' IN('public','internal','confidential')
   AND sensitivity_rank(binding->>'clearance')>=sensitivity_rank(s.effective_clearance)
   AND(binding->>'expiresAt' IS NULL OR (binding->>'expiresAt')::timestamptz>clock_timestamp())
   AND approver.role IN('owner','admin')
   AND jsonb_typeof(binding->'compartments')='array' AND jsonb_typeof(binding->'projectIds')='array'
   AND (binding->'companyWide' IS DISTINCT FROM 'true'::jsonb OR binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
   AND ((binding->'companyWide'='true'::jsonb AND binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
    OR to_jsonb(s.context_compartments)<@(binding->'compartments')
     AND(s.context_project_id IS NULL OR binding->'projectIds' ? s.context_project_id::text)),false)),false) allowed,
   coalesce(jsonb_agg(jsonb_build_object('integrationId',other_ci.id,'channelId',other_c.id,
    'binding',binding,'approver',jsonb_build_object('userId',approver.user_id,'role',approver.role))
    ORDER BY other_ci.id,binding::text),'[]'::jsonb) bindings
  FROM channel_integrations other_ci JOIN channels other_c ON other_c.id=other_ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(other_ci.config->'deliveryAudienceBindings','[]'::jsonb)) binding
  LEFT JOIN workspace_members approver ON approver.workspace_id=w AND approver.user_id=(binding->>'approvedByUserId')::uuid
  WHERE other_c.workspace_id=w AND other_c.status='active' AND other_ci.status='active' AND other_ci.channel_type='telegram'
   AND binding->>'version'='1' AND binding->>'channelId' IN(s.channel_id,split_part(s.channel_id,':',1))
 ) audience ON true
 WHERE s.recording_revision IS NOT NULL OR s.channel_type='telegram' AND s.anchor_kind='channel'
  AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
 ) SELECT coalesce(jsonb_object_agg(id::text,certificate),'{}'::jsonb) INTO recording_epochs FROM certificates;
 SELECT coalesce(jsonb_agg(p||jsonb_build_object('recordingEpoch',recording_epochs->(p->>'sessionId'))
  ORDER BY (p->'node')::text,p->>'sessionId'),'[]'::jsonb) INTO privacy_parents FROM jsonb_array_elements(privacy_parents) p;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(privacy_nodes) n WHERE n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording'))
 THEN reasons:=array_append(reasons,'unsupported_versionless_ancestry');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(privacy_parents) p WHERE p->>'sessionId' IS NOT NULL AND
   (p->>'exists' IS DISTINCT FROM 'true' OR p->>'held' IS DISTINCT FROM 'false' OR ((p->>'recordingRevision' IS NOT NULL OR p->>'legacyRecording'='true') AND p#>>'{recordingEpoch,eligible}' IS DISTINCT FROM 'true')))
 THEN reasons:=array_append(reasons,'recording_or_held_parent');END IF;
 -- No body/content/name/attachment bytes are read in these metadata relations.
 WITH n AS(SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'tag'='source')
 SELECT coalesce(jsonb_agg(jsonb_build_object('node',n.value,'resource',to_jsonb(r),'observation',to_jsonb(o)) ORDER BY n.value::text),'[]')
 INTO field_metadata FROM n LEFT JOIN application_field_resources r ON r.workspace_id=w AND r.id=(n.value->>'id')::uuid
 LEFT JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=r.id AND o.version=n.value->>'version'
 WHERE n.value->>'kind'='application_field';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f->>'resource' IS NULL OR f->>'observation' IS NULL
  OR f#>'{resource,origin}' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
  OR f#>>'{resource,type_key}' NOT IN('session_message','session_message_annotation','memory')
  OR f#>>'{resource,type_key}'='memory' AND f#>>'{resource,selection}' IS DISTINCT FROM 'query_domain'
  OR f#>>'{resource,selection}' NOT IN('read','query','identity','query_domain') OR f#>>'{resource,selected_version}' IS NOT NULL
  OR jsonb_typeof(f#>'{resource,fields}') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(f#>'{resource,fields}') k WHERE NOT k=ANY(CASE f#>>'{resource,type_key}'
    WHEN 'session_message' THEN ARRAY['id','role','content','sequenceNum','createdAt','senderUserId','senderAssistantId','channelMessageId','attachments']
    WHEN 'session_message_annotation' THEN ARRAY['id','sequenceNum','topicLabel','topicConfidence','replyToText']
    WHEN 'memory' THEN public.application_memory_field_keys() ELSE '{}'::text[] END)))
 THEN reasons:=array_append(reasons,'unsupported_or_missing_field');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('node',n,'domain',to_jsonb(q)) ORDER BY n::text),'[]') INTO domains
 FROM jsonb_array_elements(nodes) n LEFT JOIN application_query_domains q ON q.workspace_id=w AND q.id=(n->>'id')::uuid
 WHERE n->>'tag'='source' AND n->>'kind'='application_query_domain';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(domains) d WHERE d->>'domain' IS NULL
  OR d#>'{domain,origin}' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
  OR d#>>'{domain,type_key}' NOT IN('session_message','session_message_annotation','memory')
  OR d#>>'{domain,identity}' IS DISTINCT FROM d#>>'{node,version}'
  OR CASE WHEN d#>>'{domain,type_key}'='memory' THEN
    d#>>'{domain,domain,kind}' IS DISTINCT FROM 'memory_query_domain_v1'
    OR (d#>'{domain,domain}')-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
    OR d#>'{domain,domain,candidates}' IS DISTINCT FROM '[]'::jsonb OR d#>'{domain,domain,policies}' IS DISTINCT FROM '[]'::jsonb
   ELSE d#>>'{domain,domain,kind}' IS DISTINCT FROM 'session_query_domain_v1'
    OR (d#>'{domain,domain}')-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}' END)
 THEN reasons:=array_append(reasons,'unsupported_or_missing_domain');END IF;
 -- Strict empty-Memory cohort only. Absence is established in this same snapshot,
 -- not inferred from source ancestry or a formerly empty saved candidate list.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f#>>'{resource,type_key}'='memory')
 AND(NOT(CASE
 WHEN NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN true
 WHEN current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true' THEN
  application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)<=4096 AND coalesce(bool_and(private_row.user_id IS NOT NULL),false)
   FROM(SELECT user_id FROM memories WHERE workspace_id=w LIMIT 4097) private_row)
 ELSE false
END)
  OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND origin='{"kind":"native","moduleKey":"native"}' AND resource_type='memory'))
 THEN reasons:=array_append(reasons,'nonempty_or_owned_memory_cohort');END IF;
 WITH n AS(SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'tag'='source'), rows AS(
 SELECT value node,jsonb_build_object('exists',m.id IS NOT NULL,'id',m.id,'sessionId',m.session_id,'sequence',m.sequence_num,
  'workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,'version',m.scope_version,'held',m.scope_held,
  'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids) metadata
 FROM n LEFT JOIN session_messages m ON m.workspace_id=w AND m.id=(value->>'id')::uuid WHERE value->>'kind'='session_message'
 UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'sessionId',r.session_id,'parentId',r.parent_id,'parentKind',r.parent_kind,
  'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,'version',r.scope_version,'held',r.scope_held,
  'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
  'contentPresent',EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=r.id),
  'frame',CASE WHEN r.parent_kind='turn_frame' THEN (SELECT to_jsonb(f) FROM native_turn_frames f WHERE f.workspace_id=w AND f.id=r.id) ELSE NULL END)
 FROM n LEFT JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='session_context_revision'
 UNION ALL SELECT value,jsonb_build_object('exists',f.id IS NOT NULL,'id',f.id,'workspaceId',f.workspace_id,'userId',f.user_id,'assistantId',f.assistant_id,
  'version',f.scope_version,'held',f.scope_held,'sensitivity',f.sensitivity,'compartments',f.compartments,'projectIds',f.project_ids,
  'validTo',f.valid_to,'retractedAt',f.retracted_at,'supersededBy',f.superseded_by,'purpose',f.purpose,'hasDerivation',EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=f.id))
 FROM n LEFT JOIN workspace_files f ON f.workspace_id=w AND f.id=(value->>'id')::uuid WHERE value->>'kind'='workspace_file'

 UNION ALL SELECT value,jsonb_build_object('exists',e.id IS NOT NULL,'id',e.id,'workspaceId',e.workspace_id,'userId',e.user_id,'assistantId',e.assistant_id,
  'version',e.scope_version::text,'held',e.scope_held,'sensitivity',e.sensitivity,'compartments',e.compartments,'projectIds',e.project_ids,
  'validTo',NULL,'retractedAt',NULL,'sourceKind',e.source_kind)
 FROM n LEFT JOIN episodes e ON e.workspace_id=w AND e.id=(value->>'id')::uuid WHERE value->>'kind'='episode'
 UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,
  'version',r.scope_version::text,'held',r.scope_held,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
  'validTo',r.valid_to,'retractedAt',r.retracted_at,'mediaFileId',r.media_file_id,'binding',(SELECT jsonb_build_object(
   'recordingId',b.recording_id,'workspaceId',b.workspace_id,'fileId',b.file_id,'fileVersion',b.file_version,'supersededBy',b.superseded_by)
   FROM recording_intake_bindings b WHERE b.workspace_id=w AND b.recording_id=r.id))
 FROM n LEFT JOIN recordings r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='recording'
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;
 -- Canonical media is an opaque primitive subtree, never a field/policy shortcut.
 FOR media_node IN SELECT value FROM jsonb_array_elements(native_metadata) n
  WHERE n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' LOOP
  IF media_node#>>'{node,kind}'='episode' AND (media_node#>>'{metadata,sourceKind}' IS DISTINCT FROM 'recording'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='recording'
    AND peer#>>'{node,id}'=media_node#>>'{node,id}'))
   OR media_node#>>'{node,kind}'='recording' AND (media_node#>'{metadata,binding}' IS NULL OR media_node#>'{metadata,binding}'='null'::jsonb
    OR media_node#>>'{metadata,binding,supersededBy}' IS NOT NULL
    OR media_node#>>'{metadata,binding,fileId}' IS DISTINCT FROM media_node#>>'{metadata,mediaFileId}'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='episode'
     AND peer#>>'{node,id}'=media_node#>>'{node,id}')) THEN
   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_metadata');END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO media_lineage
   FROM application_scope_lineage(w,ARRAY[media_node#>>'{node,kind}'],ARRAY[(media_node#>>'{node,id}')::uuid],ARRAY[media_node#>>'{node,version}']) n;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(media_lineage) n WHERE n->>'kind' NOT IN('workspace_file','episode','recording')) THEN
   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_ancestry');END IF;
  WITH RECURSIVE physical(n) AS (
   SELECT media_node->'node'
   UNION SELECT e.child FROM physical p JOIN native_retained_graph_edges(graph,false) e ON e.parent=p.n
  ) SELECT coalesce(jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version'),'[]') INTO media_graph FROM physical;
  IF media_graph IS DISTINCT FROM media_lineage THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','media_ancestry_coverage');END IF;
 END LOOP;

 IF EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) n WHERE n#>>'{metadata,exists}' IS DISTINCT FROM 'true'
  OR n#>>'{node,kind}'='session_context_revision' AND((n#>>'{metadata,parentKind}' NOT IN('message_annotation','turn_frame') OR n#>>'{metadata,parentKind}'='turn_frame' AND native_turn_frame_pair(w,(n#>>'{node,id}')::uuid) IS NOT TRUE) OR n#>>'{metadata,version}' IS DISTINCT FROM '1' OR n#>>'{metadata,contentPresent}' IS DISTINCT FROM 'true')
  OR n#>>'{node,kind}'='workspace_file' AND(n#>>'{metadata,purpose}'='engineering_archive'
   OR EXISTS(SELECT 1 FROM workspace_file_session_bindings b WHERE b.file_id=(n#>>'{node,id}')::uuid)
   OR EXISTS(SELECT 1 FROM office_generation_file_bindings b WHERE b.file_id=(n#>>'{node,id}')::uuid)))
 THEN reasons:=array_append(reasons,'unsupported_native_metadata');END IF;
 WITH ids AS(
 SELECT (q->>'sessionId')::uuid id FROM jsonb_array_elements(selectors) q UNION
 SELECT (p->>'sessionId')::uuid id FROM jsonb_array_elements(privacy_parents) p WHERE p->>'sessionId' IS NOT NULL
 UNION SELECT (d#>>'{domain,domain,sessionId}')::uuid FROM jsonb_array_elements(domains) d WHERE d#>>'{domain,domain,sessionId}' IS NOT NULL
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'exists',s.id IS NOT NULL,'workspaceId',s.workspace_id,'assistantId',s.assistant_id,
  'userId',s.user_id,'visibility',s.visibility,'anchorKind',s.anchor_kind,'anchorRef',s.anchor_ref,'mode',s.mode,'channelType',s.channel_type,
  'channelId',s.channel_id,'appId',s.app_id,'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,
  'contextCompartments',s.context_compartments,'effectiveClearance',s.effective_clearance,'recordingHeld',s.recording_privacy_held,'recordingEpoch',recording_epochs->(s.id::text)) ORDER BY i.id),'[]')
 INTO parents FROM ids i LEFT JOIN sessions s ON s.id=i.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',d.user_id,'assistant_id',d.assistant_id,'sensitivity',d.sensitivity,'compartments',d.compartments,'project_ids',d.project_ids) ORDER BY d.id),'[]') INTO derivations FROM scope_derivations d
 WHERE d.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='source' AND n->>'kind'=d.resource_kind AND (n->>'id')::uuid=d.resource_id);
 -- Linear graph operations after source-key materialization; cycles fall back.
 order_json:=native_retained_graph_topology(graph);
 IF order_json IS NULL THEN reasons:=array_append(reasons,'semantic_cycle');END IF;
 context:=jsonb_build_object('workspaceId',w,'actor',actor,'actingAssistant',acting,'sessionUser',session_user,
  'settings',(SELECT jsonb_object_agg(k,current_setting(k,true)) FROM unnest(ARRAY[
  'app.current_user_id','app.agent_actor_id','app.agent_workspace_id','app.agent_clearance','app.agent_compartments',
  'app.agent_project_ids','app.agent_visibility_assistants','app.agent_shared_audience','app.v2_active','app.v2_assistant_id',
  'app.v2_binding','app.v2_cap','app.v2_context_department','app.application_id','app.public_share_root','app.system_bypass']) k));
 counts:=jsonb_build_object('semanticNodes',jsonb_array_length(nodes),'semanticEdges',jsonb_array_length(edges),'privacyNodes',jsonb_array_length(privacy_nodes),
  'privacyEdges',jsonb_array_length(privacy_edges),'points',(SELECT count(*) FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='point'),'domains',jsonb_array_length(domains));
 witness:=jsonb_build_object('context',context,'graph',graph,'privacyGraph',privacy_graph,'nativeMetadata',native_metadata,
  'sessionParents',parents,'derivations',derivations);
 IF discovery THEN RETURN jsonb_build_object('eligibleMetadata',cardinality(reasons)=0,'authorizationEvaluated',false,'payloadSelected',false,
  'reasons',to_jsonb(reasons),'witness',jsonb_build_object('context',context,'nativeMetadata',native_metadata,'sessionParents',parents));END IF;
 RETURN jsonb_build_object('eligibleMetadata',cardinality(reasons)=0,'authorizationEvaluated',false,'payloadSelected',false,
  'reasons',to_jsonb(reasons),'counts',counts,'evaluationOrder',order_json,'witness',witness,
  'hasMemory',EXISTS(SELECT 1 FROM jsonb_array_elements(field_metadata) f WHERE f#>>'{resource,type_key}'='memory'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'payloadSelected',false,'reason','malformed_metadata');
END $function$;

-- [COMP:api/native-chat-read-cost] Original canonical DAG reducers, independent completed maps.
CREATE FUNCTION public.native_retained_capture_requirements(w uuid, roots jsonb, selectors jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE meta jsonb;frame jsonb;source_nodes jsonb;point_values jsonb:='[]';immutable jsonb:='[]';currents jsonb:='[]';
 nodes_by_key jsonb;original_keys jsonb;root_kinds text[];root_ids uuid[];root_versions text[];node jsonb;result jsonb;source jsonb;key text;dependency jsonb;derivation jsonb;
 memo jsonb:='{"nativeWorklist":true}';observed_at timestamptz:=clock_timestamp();deadline timestamptz;
 memory_context jsonb;observation application_field_observations;field_dependencies jsonb;point_map jsonb:='{}';field_map jsonb:='{}';scope_map jsonb:='{}';query_envelopes jsonb:='{}';point_key text;
 selector jsonb;query_captures jsonb:='[]';query_parent jsonb;query_bounds jsonb;query_visibility jsonb;query_fields text[];query_scan jsonb;
 query_envelope_slots jsonb:='{}';query_envelope_values jsonb[]:='{}';query_envelope jsonb;
BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'native_turn_principal_required' USING ERRCODE='42501';END IF;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 meta:=native_retained_metadata(w,roots,selectors,false);
 IF meta->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM(
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT (audience#>>'{binding,expiresAt}')::timestamptz FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 WHERE audience#>>'{binding,expiresAt}' IS NOT NULL) transitions;
 SELECT jsonb_object_agg(native_turn_key(n),n),jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version') FILTER(WHERE n->>'tag'='source')
 INTO nodes_by_key,source_nodes FROM jsonb_array_elements(meta#>'{witness,graph,nodes}') n;
 -- Index only the exact physical field dependency predicate used below.
 WITH indexed AS MATERIALIZED(SELECT native_turn_key(edge.parent) parent_key,edge.child child
  FROM native_retained_graph_edges(meta#>'{witness,graph}',false) edge WHERE edge.child->>'kind'='application_field'),
 grouped AS(SELECT parent_key,jsonb_agg(child) children FROM indexed GROUP BY parent_key)
 SELECT coalesce(jsonb_object_agg(parent_key,children),'{}') INTO field_dependencies FROM grouped;
 WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
  SELECT parent,child FROM native_retained_graph_edges(meta#>'{witness,graph}',false)
  WHERE edge_kind IN('derivation','observation','observation_child','predecessor')
 ), original(n) AS(
  SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots)
  UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
 ) SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO original_keys FROM original;
 frame:=native_turn_capture_sources(w,meta||jsonb_build_object('declaredSourceKeys',CASE WHEN selectors='[]'::jsonb THEN original_keys ELSE '{}'::jsonb END));
 IF frame IS NULL OR frame->>'closed' IS DISTINCT FROM 'true' OR EXISTS(
 SELECT 1 FROM jsonb_each(frame->'currents') e WHERE e.value#>>'{source,held}' IS DISTINCT FROM 'false'
  OR e.value#>>'{source,validTo}' IS NOT NULL OR e.value#>>'{source,retractedAt}' IS NOT NULL)
 THEN RETURN jsonb_build_object('available',false,'reason','source_admission');END IF;
 frame:=frame||jsonb_build_object('edges',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'[]'::jsonb) FROM jsonb_array_elements(source_nodes) n));
 IF original_keys IS NULL THEN RETURN jsonb_build_object('available',false,'reason','original_cohort');END IF;
 -- The complete all-version recording graph was checked before any payload.
 frame:=frame||jsonb_build_object('validUntil',deadline,'points','{}'::jsonb,'fields','{}'::jsonb,'scopes','{}'::jsonb,
  'sourceKeys',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) FROM jsonb_array_elements(source_nodes) n),
  'privacyCovered',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id'),true) FROM jsonb_array_elements(meta#>'{witness,privacyGraph,nodes}') n));
 IF meta->>'hasMemory'='true' THEN
  memory_context:=native_turn_empty_memory_context(w);
  IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' OR NOT(CASE
 WHEN NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN true
 WHEN current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true' THEN
  application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)<=4096 AND coalesce(bool_and(private_row.user_id IS NOT NULL),false)
   FROM(SELECT user_id FROM memories WHERE workspace_id=w LIMIT 4097) private_row)
 ELSE false
END)
   OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND origin='{"kind":"native","moduleKey":"native"}' AND resource_type='memory')
   THEN RETURN jsonb_build_object('available',false,'reason','memory_requirements');END IF;
  memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows','{}'::jsonb,'cohort','[]'::jsonb));
 END IF;
 BEGIN
 FOR derivation IN SELECT value FROM jsonb_array_elements(meta#>'{witness,derivations}') LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',derivation->'user_id',
   'assistantId',derivation->'assistant_id','sensitivity',derivation->'sensitivity','compartments',derivation->'compartments','projectIds',derivation->'project_ids')) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 FOR key IN SELECT jsonb_array_elements_text(meta->'evaluationOrder') LOOP
  node:=nodes_by_key->key;
  IF node->>'tag'='point' THEN
   result:=native_turn_compact_point(w,node->>'kind',(node->>'id')::uuid,ARRAY(SELECT jsonb_array_elements_text(node->'fields')),memo,frame,scope_map);
   point_map:=point_map||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,coalesce(result->'value','null'::jsonb));
   -- Only the actual canonical-mask point may publish its query slot. An
   -- unsorted point never stands in for a not-yet-completed sorted peer.
   query_fields:=ARRAY(SELECT DISTINCT k FROM jsonb_array_elements_text(node->'fields') k ORDER BY k);
   IF node->'fields'=to_jsonb(query_fields) THEN
    query_envelope:=native_turn_compact_envelope(w,node->>'kind',(node->>'id')::uuid,'query',query_fields,memo,frame,point_map)->'value';
    query_envelope_values:=array_append(query_envelope_values,query_envelope);
    query_envelope_slots:=query_envelope_slots||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,cardinality(query_envelope_values));
   END IF;
  ELSIF node->>'kind'='application_field' THEN
   result:=native_retained_cached_field(w,(node->>'id')::uuid,node->>'version',memo,frame,point_map,field_map,query_envelope_slots,query_envelope_values);source:=result->'value';
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   field_map:=field_map||jsonb_build_object((node->>'id')||':'||(node->>'version'),source);
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
   currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);END IF;
  ELSIF node->>'kind' IN('session_message','session_context_revision','workspace_file','episode','recording') THEN
   -- This complete acyclic schedule has already evaluated every dependency.
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(field_dependencies->key,'[]')) child
    WHERE field_map#>>ARRAY[(child->>'id')||':'||(child->>'version'),'held'] IS DISTINCT FROM 'false')
   THEN RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
   source:=frame#>ARRAY['currents',(node->>'kind')||':'||(node->>'id'),'source'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   scope_map:=scope_map||jsonb_build_object((node->>'kind')||':'||(node->>'id')||':'||(node->>'version'),true);
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',node->'kind','resourceId',node->'id','version',source->'version');
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   currents:=currents||jsonb_build_array(source);
   IF node->>'kind'='session_context_revision' THEN
    IF source->>'version' IS DISTINCT FROM node->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    immutable:=immutable||jsonb_build_array(source);
   END IF;END IF;
  END IF;
 END LOOP;
 -- Both scans consume this statement's privately completed DAG. No reducer
 -- state or caller-supplied envelope crosses the SQL invocation boundary.
 FOR selector IN SELECT value FROM jsonb_array_elements(selectors) LOOP
  query_parent:=native_turn_parent(w,(selector->>'sessionId')::uuid,frame);
  query_bounds:=native_turn_session_bounds(w,query_parent);
  IF query_parent IS NULL OR query_bounds IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  query_fields:=ARRAY(SELECT k FROM unnest(application_session_field_keys(selector->>'type')) k ORDER BY k);
  query_visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL
   ELSE nullif(current_setting('app.current_user_id',true),'')::uuid END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
  query_scan:=native_turn_compact_scan(w,(selector->>'sessionId')::uuid,selector->>'type',(selector->>'through')::integer,
   query_fields,query_bounds,query_visibility,memo,frame,point_map);
  IF query_scan->'value' IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  query_captures:=query_captures||jsonb_build_array(native_turn_build_query_capture(w,(selector->>'sessionId')::uuid,
   selector->>'type',(selector->>'through')::integer,query_fields,query_parent,query_bounds,query_visibility,query_scan));
 END LOOP;
 EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'PNT01' THEN
  RETURN jsonb_build_object('available',false,'reason','requirements_unavailable');
 END;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('available',true,'admitted',true,'validUntil',deadline,'counts',meta->'counts',
  'immutable',(SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') FROM jsonb_array_elements(immutable) v),
  'current',(SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') FROM jsonb_array_elements(currents) v),
  'requirements',jsonb_build_object('nativeMetadata',meta#>'{witness,nativeMetadata}','sessionParents',meta#>'{witness,sessionParents}'),'queryCaptures',query_captures,'metadata',meta);
END $function$;

-- [COMP:api/native-chat-read-cost] Exact original-cohort projection with recording expiry.
CREATE FUNCTION public.native_retained_capture_cohorts(w uuid, roots jsonb, cohorts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE selectors jsonb:='[]';cohort jsonb;cohort_keys text[];cohort_packets jsonb:='[]';
 evidence_entries jsonb[]:='{}';evidence_map jsonb;packet jsonb;meta jsonb;frame jsonb;source_nodes jsonb;point_values jsonb:='[]';immutable jsonb:='[]';currents jsonb:='[]';
 nodes_by_key jsonb;original_keys jsonb;root_kinds text[];root_ids uuid[];root_versions text[];node jsonb;result jsonb;source jsonb;key text;dependency jsonb;derivation jsonb;
 memo jsonb:='{"nativeWorklist":true}';observed_at timestamptz:=clock_timestamp();deadline timestamptz;
 memory_context jsonb;observation application_field_observations;field_dependencies jsonb;point_map jsonb:='{}';field_map jsonb:='{}';scope_map jsonb:='{}';query_envelopes jsonb:='{}';point_key text;
 selector jsonb;query_captures jsonb:='[]';query_parent jsonb;query_bounds jsonb;query_visibility jsonb;query_fields text[];query_scan jsonb;
 query_envelope_slots jsonb:='{}';query_envelope_values jsonb[]:='{}';query_envelope jsonb;
BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'native_turn_principal_required' USING ERRCODE='42501';END IF;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 meta:=native_retained_metadata(w,roots,selectors,false);
 IF meta->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM(
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT (audience#>>'{binding,expiresAt}')::timestamptz FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 WHERE audience#>>'{binding,expiresAt}' IS NOT NULL) transitions;
 SELECT jsonb_object_agg(native_turn_key(n),n),jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version') FILTER(WHERE n->>'tag'='source')
 INTO nodes_by_key,source_nodes FROM jsonb_array_elements(meta#>'{witness,graph,nodes}') n;
 -- Index only the exact physical field dependency predicate used below.
 WITH indexed AS MATERIALIZED(SELECT native_turn_key(edge.parent) parent_key,edge.child child
  FROM native_retained_graph_edges(meta#>'{witness,graph}',false) edge WHERE edge.child->>'kind'='application_field'),
 grouped AS(SELECT parent_key,jsonb_agg(child) children FROM indexed GROUP BY parent_key)
 SELECT coalesce(jsonb_object_agg(parent_key,children),'{}') INTO field_dependencies FROM grouped;
 frame:=native_turn_capture_sources(w,meta);
 IF frame IS NULL OR frame->>'closed' IS DISTINCT FROM 'true' OR EXISTS(
 SELECT 1 FROM jsonb_each(frame->'currents') e WHERE e.value#>>'{source,held}' IS DISTINCT FROM 'false'
  OR e.value#>>'{source,validTo}' IS NOT NULL OR e.value#>>'{source,retractedAt}' IS NOT NULL)
 THEN RETURN jsonb_build_object('available',false,'reason','source_admission');END IF;
 WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
  SELECT parent,child FROM native_retained_graph_edges(meta#>'{witness,graph}',false)
  WHERE edge_kind IN('derivation','observation','observation_child','predecessor')
 ), original(n) AS(
  SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots)
  UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
 ) SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO original_keys FROM original;
 frame:=frame||jsonb_build_object('edges',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'[]'::jsonb) FROM jsonb_array_elements(source_nodes) n));
 IF original_keys IS NULL THEN RETURN jsonb_build_object('available',false,'reason','original_cohort');END IF;
 -- The complete all-version recording graph was checked before any payload.
 frame:=frame||jsonb_build_object('validUntil',deadline,'points','{}'::jsonb,'fields','{}'::jsonb,'scopes','{}'::jsonb,
  'sourceKeys',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) FROM jsonb_array_elements(source_nodes) n),
  'privacyCovered',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id'),true) FROM jsonb_array_elements(meta#>'{witness,privacyGraph,nodes}') n));
 IF meta->>'hasMemory'='true' THEN
  memory_context:=native_turn_empty_memory_context(w);
  IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' OR NOT(CASE
 WHEN NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN true
 WHEN current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true' THEN
  application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)<=4096 AND coalesce(bool_and(private_row.user_id IS NOT NULL),false)
   FROM(SELECT user_id FROM memories WHERE workspace_id=w LIMIT 4097) private_row)
 ELSE false
END)
   OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND origin='{"kind":"native","moduleKey":"native"}' AND resource_type='memory')
   THEN RETURN jsonb_build_object('available',false,'reason','memory_requirements');END IF;
  memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows','{}'::jsonb,'cohort','[]'::jsonb));
 END IF;
 BEGIN
 FOR derivation IN SELECT value FROM jsonb_array_elements(meta#>'{witness,derivations}') LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',derivation->'user_id',
   'assistantId',derivation->'assistant_id','sensitivity',derivation->'sensitivity','compartments',derivation->'compartments','projectIds',derivation->'project_ids')) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 FOR key IN SELECT jsonb_array_elements_text(meta->'evaluationOrder') LOOP
  node:=nodes_by_key->key;
  IF node->>'tag'='point' THEN
   result:=native_turn_compact_point(w,node->>'kind',(node->>'id')::uuid,ARRAY(SELECT jsonb_array_elements_text(node->'fields')),memo,frame,scope_map);
   point_map:=point_map||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,coalesce(result->'value','null'::jsonb));
   -- Only the actual canonical-mask point may publish its query slot. An
   -- unsorted point never stands in for a not-yet-completed sorted peer.
   query_fields:=ARRAY(SELECT DISTINCT k FROM jsonb_array_elements_text(node->'fields') k ORDER BY k);
   IF node->'fields'=to_jsonb(query_fields) THEN
    query_envelope:=native_turn_compact_envelope(w,node->>'kind',(node->>'id')::uuid,'query',query_fields,memo,frame,point_map)->'value';
    query_envelope_values:=array_append(query_envelope_values,query_envelope);
    query_envelope_slots:=query_envelope_slots||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,cardinality(query_envelope_values));
   END IF;
  ELSIF node->>'kind'='application_field' THEN
   result:=native_retained_cached_field(w,(node->>'id')::uuid,node->>'version',memo,frame,point_map,field_map,query_envelope_slots,query_envelope_values);source:=result->'value';
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   field_map:=field_map||jsonb_build_object((node->>'id')||':'||(node->>'version'),source);
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   evidence_entries:=array_append(evidence_entries,jsonb_build_object('key',key,
    'immutable',observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version),
    'current',source-ARRAY['held','validTo','retractedAt']));END IF;
  ELSIF node->>'kind' IN('session_message','session_context_revision','workspace_file','episode','recording') THEN
   -- This complete acyclic schedule has already evaluated every dependency.
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(field_dependencies->key,'[]')) child
    WHERE field_map#>>ARRAY[(child->>'id')||':'||(child->>'version'),'held'] IS DISTINCT FROM 'false')
   THEN RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
   source:=frame#>ARRAY['currents',(node->>'kind')||':'||(node->>'id'),'source'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   scope_map:=scope_map||jsonb_build_object((node->>'kind')||':'||(node->>'id')||':'||(node->>'version'),true);
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',node->'kind','resourceId',node->'id','version',source->'version');
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   IF node->>'kind'='session_context_revision' AND source->>'version' IS DISTINCT FROM node->>'version' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   evidence_entries:=array_append(evidence_entries,jsonb_build_object('key',key,'current',source,
    'immutable',CASE WHEN node->>'kind'='session_context_revision' THEN source ELSE NULL END));END IF;
  END IF;
 END LOOP;
 -- Keep original identity separate from the current descriptor's version.
 -- The map contains only actual physical-source obligations, not semantic
 -- query candidates or versionless privacy-only admission dependencies.
 SELECT coalesce(jsonb_object_agg(e->>'key',e-'key'),'{}') INTO evidence_map FROM unnest(evidence_entries) e;
 FOR cohort IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
  WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
   SELECT e.parent,e.child FROM native_retained_graph_edges(meta#>'{witness,graph}',false) e
   WHERE e.edge_kind IN('derivation','observation','observation_child','predecessor')
  ), original(n) AS(
   SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(cohort)
   UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
  ) SELECT coalesce(array_agg(native_turn_key(n)) FILTER(WHERE n->>'kind'<>'application_query_domain'),'{}')
   INTO cohort_keys FROM original;
  IF cardinality(cohort_keys)=0 OR EXISTS(SELECT 1 FROM unnest(cohort_keys) k WHERE NOT evidence_map ? k)
  THEN RAISE EXCEPTION 'native_turn_cohort_projection_missing' USING ERRCODE='42501';END IF;
  SELECT jsonb_build_object(
   'current',coalesce(jsonb_agg(evidence_map->k->'current' ORDER BY (evidence_map->k->'current')::text),'[]'),
   'immutable',coalesce(jsonb_agg(evidence_map->k->'immutable' ORDER BY (evidence_map->k->'immutable')::text)
    FILTER(WHERE evidence_map->k->'immutable' IS DISTINCT FROM 'null'::jsonb),'[]'))
   INTO packet FROM unnest(cohort_keys) k;
  cohort_packets:=cohort_packets||jsonb_build_array(packet);
 END LOOP;
 EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'PNT01' THEN
  RETURN jsonb_build_object('available',false,'reason','requirements_unavailable');
 END;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('available',true,'admitted',true,'validUntil',deadline,'cohorts',cohort_packets,
  'requirements',jsonb_build_object('nativeMetadata',meta#>'{witness,nativeMetadata}','sessionParents',meta#>'{witness,sessionParents}'));
END $function$;

-- [COMP:api/native-chat-read-cost] Fresh lock discovery and coherent canonical acquisition.
CREATE FUNCTION public.read_native_retained_requirements(w uuid, roots jsonb, selectors jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;context jsonb;discovered jsonb;
BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 discovered:=native_retained_metadata(w,roots,selectors,true);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 SELECT native_retained_capture_requirements(w,roots,selectors) INTO result;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF result->>'available'='true' AND (
  result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}')
 THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 IF result->>'available'='true' AND clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN result;
END $function$;

CREATE FUNCTION public.read_native_retained_scope_evidence(w uuid, roots jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 result:=read_native_retained_requirements(w,roots,'[]'::jsonb);
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF result->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',result->'immutable','current',result->'current');
END $function$;

CREATE FUNCTION public.read_native_retained_publication_cohorts(w uuid, cohorts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE roots jsonb;cohort jsonb;identity jsonb;result jsonb;context jsonb;discovered jsonb;
BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'native_turn_principal_required' USING ERRCODE='42501';END IF;
 IF w IS NULL OR jsonb_typeof(cohorts) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(cohorts)<>2 THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
 FOR cohort IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
  IF jsonb_typeof(cohort) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(cohort) NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  FOR identity IN SELECT value FROM jsonb_array_elements(cohort) LOOP
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['kind','id','version']<>'{}'
    OR NOT identity ?& ARRAY['kind','id','version'] OR jsonb_typeof(identity->'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(identity->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(identity->'version') IS DISTINCT FROM 'string'
    OR length(identity->>'version') NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
   IF identity->>'kind' NOT IN('application_field','session_message','session_context_revision','workspace_file') THEN
    RAISE EXCEPTION 'native_turn_cohort_source_kind' USING ERRCODE='22023';END IF;
   IF (identity->>'id')::uuid IS NULL THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 SELECT jsonb_agg(n ORDER BY native_turn_key(n||'{"tag":"source"}'::jsonb)) INTO roots
 FROM(SELECT DISTINCT i.value n FROM jsonb_array_elements(cohorts) c CROSS JOIN LATERAL jsonb_array_elements(c.value) i) union_roots;
 -- An oversized union can retain the original independent readers. No
 -- authority has been evaluated and no write has occurred at this point.
 IF jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
 context:=native_turn_context();
 discovered:=native_retained_metadata(w,roots,'[]'::jsonb,true);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN
  IF discovered->>'authorizationEvaluated'='false'
   OR discovered='{"eligibleMetadata":false,"reason":"selector_candidate_bound"}'::jsonb THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'native_turn_cohort_discovery_refused' USING ERRCODE='42501';END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RAISE EXCEPTION 'native_turn_lock_coverage' USING ERRCODE='42501';END IF;
 SELECT native_retained_capture_cohorts(w,roots,cohorts) INTO result;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_turn_context() IS DISTINCT FROM context THEN
  RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF result->>'available' IS DISTINCT FROM 'true' OR result->>'admitted' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'native_turn_cohort_capture_refused' USING ERRCODE='42501';END IF;
 IF result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}' THEN
  RAISE EXCEPTION 'native_turn_lock_coverage' USING ERRCODE='42501';END IF;
 IF result->>'validUntil' IS NULL OR clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('admitted',true,'cohorts',result->'cohorts');
END $function$;

-- [COMP:api/native-chat-read-cost] Exact staged adjacency, without another full compiler pass.
CREATE FUNCTION native_retained_capture_plan(w uuid, initial jsonb, captures jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE semantic jsonb:=initial#>'{metadata,witness,graph}';privacy jsonb:=initial#>'{metadata,witness,privacyGraph}';
 staged jsonb;prior_nodes integer;frontier jsonb;batch jsonb;attempts integer:=0;
BEGIN
 IF semantic IS NULL OR privacy IS NULL OR jsonb_array_length(captures)>4096 THEN RETURN NULL;END IF;
 WITH c AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(captures)), staged(parent,child,edge_kind) AS (
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}','version',e#>'{state,sourceVersion}'),'observation'
  FROM c
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',s->'resourceKind','id',s->'resourceId','version',s->'version'),'observation_child'
  FROM c CROSS JOIN LATERAL jsonb_array_elements(e->'sources') s
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','point','kind',e->'typeKey','id',e->'id','fields',e->'fields'),'field_point'
  FROM c WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation') AND e->>'selectedVersion' IS NULL
   AND e->>'selection' IN('read','query','identity')
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_query_domain','id',q->'domainId','version',q->'domainIdentity'),
   jsonb_build_object('tag','point','kind',q->'type','id',m.id,'fields',q#>'{domain,fields}'),'domain_candidate'
  FROM jsonb_array_elements(initial->'queryCaptures') q JOIN session_messages m
   ON m.workspace_id=w AND m.session_id=(q#>>'{domain,sessionId}')::uuid
   AND m.sequence_num<=(q#>>'{domain,throughSequence}')::integer
 ) SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO staged FROM staged s;
 semantic:=native_retained_graph_overlay(semantic,staged,false);
 IF semantic IS NULL OR native_retained_graph_topology(semantic) IS NULL THEN RETURN NULL;END IF;
 WITH c AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(captures)), staged(parent,child) AS (
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}') FROM c
  UNION ALL
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',s->'resourceKind','id',s->'resourceId')
  FROM c CROSS JOIN LATERAL jsonb_array_elements(e->'sources') s
  UNION ALL
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind','session_message','id',e->'id') FROM c
  WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation')
 ) SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO staged FROM staged s;
 prior_nodes:=jsonb_array_length(privacy->'nodes');
 privacy:=native_retained_graph_overlay(privacy,staged,true);
 IF privacy IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') INTO frontier
 FROM jsonb_array_elements(privacy->'nodes') WITH ORDINALITY WHERE ordinality>prior_nodes;
 -- Existing nodes were fully expanded during initial discovery. Close each
 -- newly introduced versionless node with the unchanged canonical edge reader.
 WHILE jsonb_array_length(frontier)>0 LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RETURN NULL;END IF;
  prior_nodes:=jsonb_array_length(privacy->'nodes');
  privacy:=native_retained_expand_frontier(w,privacy,frontier,true);
  IF privacy IS NULL THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') INTO frontier
  FROM jsonb_array_elements(privacy->'nodes') WITH ORDINALITY WHERE ordinality>prior_nodes;
 END LOOP;
 RETURN jsonb_build_object('semantic',semantic,'privacy',privacy);
END $$;

-- [COMP:api/native-chat-read-cost] Original canonical materialization and independent post-write proof.
CREATE FUNCTION public.read_native_retained_session_query(w uuid, s uuid, body_through integer, topics_through integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE roots jsonb;selectors jsonb;initial jsonb;fresh jsonb;context jsonb;captured jsonb;frozen application_query_domains;
 all_captures jsonb:='[]';sources jsonb;source_tuple jsonb;history jsonb;annotations jsonb;
 capture_plan jsonb;

BEGIN
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF body_through IS NULL OR topics_through IS NULL OR body_through<0 OR topics_through<0 THEN RETURN NULL;END IF;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 context:=native_turn_context();
 -- Identities only: complete payload and actual-principal checks are private.
 SELECT jsonb_agg(n ORDER BY n::text) INTO roots FROM (
  SELECT jsonb_build_object('kind','session_message','id',m.id,'version',m.scope_version::text) n
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s
   AND m.sequence_num<=greatest(body_through,topics_through) LIMIT 4097
 ) candidates;
 IF roots IS NULL OR jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
 selectors:=jsonb_build_array(jsonb_build_object('type','session_message','sessionId',s,'through',body_through),
  jsonb_build_object('type','session_message_annotation','sessionId',s,'through',topics_through));
 SELECT read_native_retained_requirements(w,roots,selectors) INTO initial;
 IF initial->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR clock_timestamp()>=(initial->>'validUntil')::timestamptz THEN RETURN NULL;END IF;
 IF jsonb_array_length(initial->'queryCaptures') IS DISTINCT FROM 2 THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(expanded.value),'[]') INTO all_captures FROM jsonb_array_elements(initial->'queryCaptures') q
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(q->'envelope')||coalesce(q#>'{envelope,children}','[]')) expanded(value);
 -- The complete initial graph remains private; no redundant metadata compile.
 capture_plan:=native_retained_capture_plan(w,initial,all_captures);
 IF capture_plan IS NULL OR native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR clock_timestamp()>=(initial->>'validUntil')::timestamptz THEN RETURN NULL;END IF;

 -- From the first immutable write onward, failure aborts the whole operation.
 FOR captured IN SELECT value FROM jsonb_array_elements(initial->'queryCaptures') LOOP
  INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
   VALUES((captured->>'domainId')::uuid,w,'{"kind":"native","moduleKey":"native"}',captured->>'type','1',captured->'domain',captured->>'domainIdentity')
   ON CONFLICT DO NOTHING;
  SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=(captured->>'domainId')::uuid;
  IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM
   ('{"kind":"native","moduleKey":"native"}'::jsonb,captured->>'type','1',captured->'domain',captured->>'domainIdentity')
  THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
  PERFORM application_materialize_field_envelope(w,captured->'envelope');
  IF captured->>'type'='session_message' THEN history:=captured->'rows';ELSE annotations:=captured->'rows';END IF;
 END LOOP;
 SELECT jsonb_agg(source ORDER BY source::text) INTO sources FROM (SELECT DISTINCT value->'source' source FROM jsonb_array_elements(all_captures)) selected;
 SELECT jsonb_agg(jsonb_build_object('kind',v->>'resourceKind','id',v->>'resourceId','version',v->>'version') ORDER BY v::text)
  INTO roots FROM jsonb_array_elements(sources) v;
 -- This is a distinct READ COMMITTED SPI command after observation DML. It
 -- rebuilds canonical domains and points with fresh state, grants and time.
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 SELECT read_native_retained_requirements(w,roots,'[]'::jsonb) INTO fresh;
 IF fresh->>'available' IS DISTINCT FROM 'true' OR fresh->>'admitted' IS DISTINCT FROM 'true'
  OR native_turn_context() IS DISTINCT FROM context OR native_retained_helpers_current() IS NOT TRUE
  OR clock_timestamp()>=(fresh->>'validUntil')::timestamptz
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR source_tuple IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fresh->'immutable') original WHERE original=source_tuple)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fresh->'current') current_source WHERE current_source=source_tuple)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF fresh#>'{requirements,nativeMetadata}' IS DISTINCT FROM initial#>'{requirements,nativeMetadata}'
  OR fresh#>'{requirements,sessionParents}' IS DISTINCT FROM initial#>'{requirements,sessionParents}'
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_retained_graph_equal(capture_plan->'semantic',fresh#>'{metadata,witness,graph}',false) IS NOT TRUE
  OR native_retained_graph_equal(capture_plan->'privacy',fresh#>'{metadata,witness,privacyGraph}',true) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('history',history,'annotations',annotations,
  'proof',jsonb_build_object('admitted',true,'immutable',fresh->'immutable','current',fresh->'current'));
END
$function$;
$new_readers$,'__RETAINED_GUARD_FINGERPRINT__',guard_fingerprint);
 FOREACH routine_signature IN ARRAY ARRAY['native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_helpers_current()','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_node_key(jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)']::text[] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',routine_signature);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM app_user',routine_signature);END IF;
  IF split_part(routine_signature,'(',1)=ANY(ARRAY['read_native_retained_session_query','read_native_retained_scope_evidence','read_native_retained_publication_cohorts']::text[]) AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO app_user',routine_signature);
  END IF;
 END LOOP;
 -- Change the canonical metadata projection and two authenticated dispatchers. All writer/seal/deferred
 -- publication and RLS implementations retain their original bodies.
 EXECUTE replace($dispatches$-- [COMP:api/native-chat-read-cost] Canonical selector scalars are extracted once per retained domain.
CREATE OR REPLACE FUNCTION public.native_turn_edges(w uuid, frontier jsonb)
 RETURNS TABLE(parent jsonb, child jsonb, edge_kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 WITH RECURSIVE f AS MATERIALIZED(SELECT value n FROM jsonb_array_elements(frontier)),
 domain_selectors AS MATERIALIZED(
  SELECT n parent,q.type_key,(q.domain->>'sessionId')::uuid session_id,
   (q.domain->>'throughSequence')::integer through_sequence,q.domain->'fields' selected_fields
  FROM f JOIN application_query_domains q ON n->>'tag'='source' AND n->>'kind'='application_query_domain'
   AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  WHERE q.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND q.type_key IN('session_message','session_message_annotation') AND q.domain->>'kind'='session_query_domain_v1'
 ),
 -- Canonical file ancestry emits ALL predecessors, with the root's requested
 -- version on each edge. Immediate-only edges would alter the edge witness.
 predecessors(root,id) AS (
  SELECT n,wf.id FROM f JOIN workspace_files wf ON n->>'tag'='source'
   AND n->>'kind'='workspace_file' AND wf.workspace_id=w AND wf.id=(n->>'id')::uuid
  UNION
  SELECT p.root,wf.id FROM predecessors p JOIN workspace_files wf
   ON wf.workspace_id=w AND wf.superseded_by=p.id
 ), e AS (
  SELECT n parent,jsonb_build_object('tag','source','kind',s.source_kind,'id',s.source_id,'version',s.source_version) child,'derivation'::text edge_kind
  FROM f JOIN scope_derivations d ON n->>'tag'='source' AND d.workspace_id=w
   AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind',o.source_kind,'id',o.source_id,'version',o.source_version),'observation'
  FROM f JOIN application_field_observations o ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind',s.source_kind,'id',s.source_id,'version',s.source_version),'observation_child'
  FROM f JOIN application_field_observation_sources s ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid AND s.version=n->>'version'
  UNION ALL
  SELECT root,jsonb_build_object('tag','source','kind','workspace_file','id',id,'version',root->>'version'),'predecessor'
  FROM predecessors WHERE id<>(root->>'id')::uuid
  UNION ALL
  -- A point dependency is added even when it was filtered from an older scan.
  SELECT n,jsonb_build_object('tag','point','kind',r.type_key,'id',r.resource_id,'fields',to_jsonb(r.fields)),'field_point'
  FROM f JOIN application_field_resources r ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE r.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND r.type_key IN('session_message','session_message_annotation') AND r.selected_version IS NULL
   AND r.selection IN('read','query','identity')
  UNION ALL
  -- Every physical row, not only admitted/recorded domain candidates.
  SELECT d.parent,jsonb_build_object('tag','point','kind',d.type_key,'id',m.id,'fields',d.selected_fields),'domain_candidate'
  FROM domain_selectors d JOIN session_messages m ON m.workspace_id=w AND m.session_id=d.session_id
   AND m.sequence_num<=d.through_sequence
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text),'point_body'
  FROM f JOIN session_messages m ON n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind','session_context_revision','id',r.id,'version',r.scope_version::text),'point_head'
  FROM f JOIN session_messages m ON n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=m.id
  JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
   AND r.session_id=m.session_id AND r.parent_kind='message_annotation' AND r.parent_id=m.id
  UNION ALL
  -- Conservative dependency: parent-message full closure, never parent ID alone.
  SELECT n,jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text),'revision_parent'
  FROM f JOIN session_context_scope_revisions r ON n->>'tag'='source' AND n->>'kind'='session_context_revision'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.parent_kind='message_annotation'
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=r.session_id AND m.id=r.parent_id
 ) SELECT DISTINCT parent,child,edge_kind FROM e
$function$;
CREATE OR REPLACE FUNCTION public.native_turn_prepare_publication(w uuid, s uuid, producer text, sources jsonb, target jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;proof jsonb;roots jsonb;declared jsonb;source jsonb;current_source jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;tier text;teams text[];projects uuid[];
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256 OR entity_derivation_envelope_valid(target) IS NOT TRUE
  OR target->>'workspaceId' IS DISTINCT FROM w::text OR target->>'assistantId' IS NOT NULL
  OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId' THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Initial native profile retains exact current versions. Other D1 cases use the original writer.
 IF target->'userId' IS DISTINCT FROM parent->'userId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(sources) n
  WHERE n->>'resourceKind' NOT IN('session_message','session_context_revision','application_field','workspace_file')) THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(source->'version') IS DISTINCT FROM 'string' OR length(btrim(source->>'version')) NOT BETWEEN 1 AND 256
   OR (source->>'resourceId')::uuid IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('kind',n->'resourceKind','id',n->'resourceId','version',n->'version')) INTO roots FROM jsonb_array_elements(sources) n;
 -- Authenticate the separate retained contract before executing its code.
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) THEN
  IF native_retained_helpers_current() IS TRUE THEN
  proof:=read_native_retained_requirements(w,roots,'[]'::jsonb);
  IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE
  THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 END IF;
 END IF;
 IF proof->>'available' IS DISTINCT FROM 'true' THEN proof:=read_native_turn_compact_requirements(w,roots,'[]'::jsonb);END IF;
 IF proof->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 SELECT jsonb_agg(n ORDER BY n::text) INTO declared FROM(SELECT DISTINCT value n FROM jsonb_array_elements(sources||(proof->'immutable'))) all_sources;
 IF jsonb_array_length(declared)>4096 OR (SELECT count(DISTINCT(n->>'resourceKind',n->>'resourceId')) FROM jsonb_array_elements(declared) n)<>jsonb_array_length(declared)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(declared) LOOP
  SELECT n INTO current_source FROM jsonb_array_elements(proof->'current') n
  WHERE n->>'resourceKind'=source->>'resourceKind' AND n->>'resourceId'=source->>'resourceId';
  IF current_source IS NULL OR current_source IS DISTINCT FROM source THEN RETURN NULL;END IF;
  IF source->>'userId' IS NOT NULL AND source->'userId' IS DISTINCT FROM target->'userId' THEN RETURN NULL;END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(tier) THEN tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) value ORDER BY value);
 END LOOP;
 IF member_operation_scope_allows(w,tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(tier,teams,projects) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('scope',jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,
  'sensitivity',tier,'compartments',teams,'projectIds',projects),'retained',declared,
  'proof',jsonb_build_object('validUntil',proof->'validUntil','admitted',true,'immutable',proof->'immutable','current',proof->'current'));
END $function$;
CREATE OR REPLACE FUNCTION public.read_native_turn_requirements(w uuid, roots jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;context jsonb;discovered jsonb;
BEGIN
 context:=native_turn_context();
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) THEN
  IF native_retained_helpers_current() IS TRUE THEN
  result:=read_native_retained_requirements(w,roots,'[]'::jsonb);
  IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE
  THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF result->>'available'='true' THEN RETURN result-ARRAY['metadata','queryCaptures'];END IF;
  END IF;
 END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 discovered:=native_turn_metadata_acquire(w,roots);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 SELECT native_turn_capture_requirements(w,roots) INTO result;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF result->>'available'='true' AND (
  result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}')
 THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 IF result->>'available'='true' AND clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN result;
END $function$;$dispatches$,'__RETAINED_GUARD_FINGERPRINT__',guard_fingerprint);
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_edges(uuid,jsonb)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)'] LOOP
  old_row:=prior->routine_signature;
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  IF to_jsonb(actual)-'prosrc' IS DISTINCT FROM old_row-'prosrc' THEN RAISE EXCEPTION 'retained_reader_dispatch_metadata_changed: %',routine_signature;END IF;
  UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex')
   WHERE h.signature=routine_signature AND h.fingerprint=encode(sha256(convert_to(old_row::text,'UTF8')),'hex');
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'retained_reader_dispatch_predecessor_changed: %',routine_signature;END IF;
 END LOOP;
 FOREACH routine_signature IN ARRAY ARRAY['native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_helpers_current()','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_node_key(jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_privacy_edges(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)']::text[] LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  IF actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT(split_part(routine_signature,'(',1)=ANY(ARRAY['read_native_retained_session_query','read_native_retained_scope_evidence','read_native_retained_publication_cohorts']::text[]) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'retained_reader_install_acl_changed: %',routine_signature;END IF;
  INSERT INTO native_retained_contract_helpers VALUES(routine_signature,encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex'));
 END LOOP;
 IF native_retained_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'retained_reader_install_contract_changed' USING DETAIL=jsonb_build_object(
   'native',native_turn_helpers_current(),
   'rows',(SELECT count(*) FROM native_retained_contract_helpers),
   'changed',(SELECT jsonb_agg(h.signature) FROM native_retained_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)
     WHERE p.oid IS NULL OR h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),
   'shape',(SELECT jsonb_build_object('owner',r.relowner=owner_id,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,
     'columns',(SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype,attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped)) FROM pg_class r WHERE r.oid='native_retained_contract_helpers'::regclass))::text;
 END IF;
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||routine_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_successor_guard_changed: %',routine_signature;END IF;
 END LOOP;
END $retained_install$;
COMMIT;
