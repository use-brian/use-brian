-- [COMP:api/native-turn-frame] One publication algorithm, format-1 read compatibility.
-- Generated from scripts/conversation-store; no applied migration is modified.
BEGIN;
DO $retained_install$
DECLARE expected jsonb;actual pg_proc;prior jsonb:='{}';routine_signature text;old_row jsonb;guard_fingerprint text;changed integer;ok boolean;
 declared_roster text;declared_native_members constant text[]:=ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_field_digest(jsonb)','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_query_context(uuid)','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','assistant_placement_visible(uuid,uuid)','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_scope_source(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','scope_review_state_held(text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','sensitivity_rank(text)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[];
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 -- Authenticate the executable root before invoking its protected closed
 -- predecessor contract. Catalog hashes include metadata and effective ACLs.
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"native_turn_helpers_current()","language":"sql","volatility":"s","bodyTemplate":"803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"native_turn_publication_contract()","language":"sql","volatility":"s","bodyTemplate":"publication-tables-8196","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_publication_contract","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]'::jsonb) LOOP
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
END $retained_install$;

DO $flat_authentication$
DECLARE actual pg_proc;body text;pins text;pin_count integer;definition text;
 trigger_state jsonb;table_state jsonb;shape_sql text;fk_query text;fk_state jsonb;
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 member_oids oid[];dependency_tables text;own_tables text;
 original_dependency pg_proc;auth_rows text;auth_body text;candidate text;
 legacy_tables jsonb;legacy_fk jsonb;variant integer;accepted boolean;
 original_metadata jsonb;
BEGIN
 -- Shared pg_proc catalog projection used by the flat queue guards.
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
  string_agg(format('format(%L,%s)', '%L::'||CASE WHEN attname='proacl' THEN 'jsonb' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN 'text' ELSE format_type(atttypid,atttypmod) END,
   CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END),'||'',''||' ORDER BY attnum),
  string_agg(format('%s%s IS NOT DISTINCT FROM m.%I%s',CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END,attname,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END),' AND ' ORDER BY attnum),
  jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum)
 INTO columns_sql,row_sql,comparisons,catalog_shape
 FROM pg_attribute WHERE attrelid='pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 -- Reconstruct the exact dependency template used by 8188 and 8195.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count
 FROM pg_proc p WHERE p.oid IN(
  SELECT tgfoid FROM pg_trigger WHERE tgrelid='scope_derivation_sources'::regclass AND NOT tgisinternal
  UNION SELECT unnest(ARRAY['validate_native_field_dependency_batch(uuid,uuid,jsonb)'::regprocedure,
   'read_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,
   'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
   'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
   'application_native_file_capture_helpers_current()'::regprocedure,
   'application_empty_query_helpers_current()'::regprocedure,
   'application_memory_statement_helpers_current()'::regprocedure]::oid[]));
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_state FROM pg_trigger t
 WHERE t.tgrelid IN('scope_derivation_sources'::regclass,'native_field_dependency_batches'::regclass,'native_field_dependency_work'::regclass);
 shape_sql:=$shape$SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid)
  FROM pg_class c WHERE c.oid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass,
   pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass)),
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated,a.attisdropped,a.attacl) ORDER BY a.attrelid,a.attnum)
  FROM pg_attribute a WHERE a.attnum>0 AND a.attrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d
  WHERE d.adrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p
  WHERE p.polrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r
  WHERE r.ev_class IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)),
 'sequence',(SELECT to_jsonb(s) FROM pg_sequence s WHERE s.seqrelid=pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass),
 'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
  WHERE c.conrelid IN('public.native_field_dependency_batches'::regclass,'public.native_field_dependency_work'::regclass)))$shape$;
 EXECUTE shape_sql INTO table_state;
 body:='BEGIN
 IF (SELECT count(*)='||pin_count||' AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN(''public.scope_derivation_sources''::regclass,''public.native_field_dependency_batches''::regclass,''public.native_field_dependency_work''::regclass)) IS DISTINCT FROM '||quote_literal(trigger_state::text)||'::jsonb THEN RETURN false;END IF;
 IF ('||shape_sql||') IS DISTINCT FROM '||quote_literal(table_state::text)||'::jsonb THEN RETURN false;END IF;
 RETURN application_native_file_capture_helpers_current();
 END';
 dependency_tables:=substring(body FROM position('THEN RETURN false;END IF;' IN body)+length('THEN RETURN false;END IF;'));
 dependency_tables:=split_part(dependency_tables,'RETURN application_native_file_capture_helpers_current();',1);
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM jsonb_array_elements_text('["agent_read_scope_allows(text,text[],uuid[])","agent_scope_grant_allows(text,text[])","agent_visibility_allows(uuid,uuid,uuid)","application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)","application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)","application_empty_query_helpers_current()","application_empty_query_worklist_current(uuid,jsonb)","application_empty_query_worklist_reset(jsonb)","application_field_digest(jsonb)","application_field_envelope_ancestry_allowed(uuid,jsonb)","application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])","application_field_resource_uuid(text)","application_memory_field_keys()","application_memory_field_state(uuid,uuid,text[])","application_memory_field_state_before_successor(uuid,uuid,text[])","application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)","application_memory_history_status(uuid,uuid,text)","application_memory_query_candidate_state(uuid,uuid,text[],jsonb)","application_memory_query_context(uuid)","application_memory_query_domain_state(uuid,uuid,text[])","application_memory_statement_domain(uuid,uuid,text[],jsonb)","application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)","application_memory_statement_helpers_current()","application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)","application_memory_statement_state(uuid,uuid,text[],jsonb)","application_native_catalog_port_valid(regprocedure)","application_native_field_catalog_for(uuid,jsonb,text)","application_native_field_contract_before_catalog(uuid,jsonb,text,text)","application_native_field_contract_for(uuid,jsonb,text,text)","application_native_field_rule_allows(jsonb,text[])","application_native_file_capture_helpers_current()","application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","application_native_member_field_permissions(uuid,jsonb,uuid)","application_native_query_bounds(uuid)","application_native_record_port_valid(regprocedure)","application_native_same_destination(uuid,text,uuid,text,uuid)","application_native_source_edges_dispatch(uuid,text,uuid,text)","application_normalize_native_query_bounds(jsonb)","application_principal_query_bounds(uuid,uuid,boolean)","application_query_scope_cap(integer,jsonb,jsonb)","application_query_scope_intersection(jsonb,jsonb)","application_query_scope_valid(jsonb)","application_query_set_intersection(jsonb,jsonb)","application_reader_envelope_visible(uuid,jsonb)","application_recorded_field_root_capture(uuid,uuid,text,integer)","application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)","application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)","application_scope_lineage(uuid,text[],uuid[],text[])","application_scope_source_edges(uuid,text,uuid,text)","application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)","application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)","application_session_eval_field(uuid,uuid,text,jsonb)","application_session_eval_scope(uuid,text,uuid,text,jsonb)","assistant_placement_visible(uuid,uuid)","capture_native_session_projection_batch(uuid,uuid,integer,text)","crm_capture_erasure_effect()","department_principal_grant_snapshot(uuid)","department_read_grants()","department_read_grants_for(uuid)","department_row_allows(jsonb,uuid,text,text[],uuid)","effective_member_read_compartments(uuid,uuid)","effective_member_team_compartments(uuid,uuid)","enqueue_native_field_dependency_work()","entity_derivation_envelope_valid(jsonb)","guard_application_field_lineage()","guard_external_source_derivation()","guard_page_derivation_receipts()","guard_session_context_lineage()","guard_session_recording_privacy()","guard_workflow_derivation_receipts()","knowledge_version_source_edges(uuid,text,uuid,text)","legacy_assistant_team_compartments(uuid)","member_operation_grants(boolean,uuid)","member_operation_row_allows(jsonb,uuid,text,text[])","member_operation_scope_allows(uuid,text,text[],boolean)","member_principal_operation_grants(uuid,boolean,uuid)","project_member_live(uuid,text,uuid)","read_admitted_native_scope_snapshot(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)","read_application_field_dependencies(uuid,text[],uuid[],text[])","read_entity_derivation_source(uuid,text,uuid)","read_entity_derivation_source_before_application_fields(uuid,text,uuid)","read_entity_derivation_source_before_blueprint(uuid,text,uuid)","read_entity_derivation_source_before_browser_profile(uuid,text,uuid)","read_entity_derivation_source_before_browser_session(uuid,text,uuid)","read_entity_derivation_source_before_capture(uuid,text,uuid)","read_entity_derivation_source_before_conversation(uuid,text,uuid)","read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)","read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)","read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)","read_entity_derivation_source_before_memory_successor(uuid,text,uuid)","read_entity_derivation_source_before_page(uuid,text,uuid)","read_entity_derivation_source_before_persistent_context(uuid,text,uuid)","read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)","read_entity_derivation_source_before_recordings(uuid,text,uuid)","read_entity_derivation_source_before_workflow_run(uuid,text,uuid)","read_external_source_dependencies(uuid,text[],uuid[],text[])","read_media_parent_snapshot(uuid,text,uuid)","read_media_parent_snapshot_before_blueprint(uuid,text,uuid)","read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)","read_media_parent_snapshot_before_browser_session(uuid,text,uuid)","read_media_parent_snapshot_before_conversation(uuid,text,uuid)","read_media_parent_snapshot_before_page(uuid,text,uuid)","read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)","read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)","read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)","read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","read_native_file_session_field_snapshots(uuid,uuid[],text[])","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","read_resource_page_dependencies(uuid,text,uuid,text)","read_scope_source(uuid,text,uuid)","read_scope_source_before_application_fields(uuid,text,uuid)","read_scope_source_before_browser_profile(uuid,text,uuid)","read_scope_source_before_browser_session(uuid,text,uuid)","read_scope_source_before_external(uuid,text,uuid)","read_scope_source_before_knowledge_binding(uuid,text,uuid)","read_scope_source_before_page(uuid,text,uuid)","read_scope_source_before_persistent_context(uuid,text,uuid)","read_scope_source_before_routines(uuid,text,uuid)","read_scope_source_before_workflow_run(uuid,text,uuid)","recording_source_read_allowed(uuid,text,uuid)","refuse_quarantined_recording_message()","scope_review_state_held(text,uuid)","scope_source_ancestors(uuid,text,uuid)","scope_source_ancestors_before_browser_profile(uuid,text,uuid)","scope_source_ancestors_before_browser_session(uuid,text,uuid)","scope_source_ancestors_before_workflow_run(uuid,text,uuid)","scope_source_table(text)","scope_source_table_before_knowledge_versions(text)","scope_source_table_before_media(text)","scope_source_table_before_persistent_context(text)","sensitivity_rank(text)","session_recording_read_allowed(uuid)","validate_application_field_dependencies()","validate_native_field_dependency_batch(uuid,uuid,jsonb)","validate_page_derivation_dependencies()","validate_scope_resource_reference()","validate_workflow_derivation_dependencies()","workflow_evidence_envelope_visible(uuid,jsonb)"]'::jsonb) r(signature);
 IF array_position(member_oids,NULL) IS NOT NULL OR cardinality(member_oids)<>153 THEN RAISE EXCEPTION 'Flat queue prerequisite roster changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
  body:='BEGIN IF (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb THEN RETURN false;END IF; IF (SELECT count(*)='||cardinality(member_oids)||' AND coalesce(bool_and('||comparisons||'),false) FROM (VALUES '||rows_sql||') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;'||''||dependency_tables||'RETURN true;END';
 SELECT * INTO actual FROM pg_proc WHERE oid='public.application_native_dependency_batch_helpers_current()'::regprocedure;
 IF actual.oid IS NULL OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname']) IS DISTINCT FROM
   '{"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
 IF actual.prosrc IS DISTINCT FROM body THEN RAISE EXCEPTION 'conversation_flat_predecessor_changed: dependency';END IF;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid) INTO pins
 FROM pg_proc p WHERE p.oid IN(
 'read_native_field_reference_snapshot(uuid,uuid,uuid,text)'::regprocedure,
 'validate_scope_resource_reference()'::regprocedure,
 'application_current_field_snapshot(uuid,uuid)'::regprocedure,
 'read_scope_source(uuid,text,uuid)'::regprocedure,
 'recording_source_read_allowed(uuid,text,uuid)'::regprocedure,
 'application_native_dependency_batch_helpers_current()'::regprocedure,
 'application_native_file_capture_helpers_current()'::regprocedure,
 'application_memory_statement_helpers_current()'::regprocedure);
 fk_query:=$fk$SELECT jsonb_build_object(
 'constraint',(SELECT to_jsonb(c) FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey'),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=(SELECT c.oid FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey')),
 'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid IN(SELECT t.tgfoid FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=(SELECT c.oid FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.conname='scope_derivation_sources_workspace_id_derivation_id_fkey'))),
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relkind,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid IN('public.scope_derivation_sources'::regclass,'public.scope_derivations'::regclass)),
 'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_catalog.pg_rewrite r WHERE r.ev_class IN('public.scope_derivation_sources'::regclass,'public.scope_derivations'::regclass)))$fk$;
 EXECUTE fk_query INTO fk_state;
 body:='BEGIN
 IF (SELECT count(*)=8 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
 FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF ('||fk_query||') IS DISTINCT FROM '||quote_literal(fk_state::text)||'::jsonb THEN RETURN false;END IF;
 RETURN application_native_dependency_batch_helpers_current();
 END';
 own_tables:=substring(body FROM position('THEN RETURN false;END IF;' IN body)+length('THEN RETURN false;END IF;'));
 own_tables:=split_part(own_tables,'RETURN application_native_dependency_batch_helpers_current();',1);
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM jsonb_array_elements_text('["agent_read_scope_allows(text,text[],uuid[])","agent_scope_grant_allows(text,text[])","agent_visibility_allows(uuid,uuid,uuid)","application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)","application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)","application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)","application_current_field_snapshot(uuid,uuid)","application_empty_query_helpers_current()","application_empty_query_worklist_current(uuid,jsonb)","application_empty_query_worklist_reset(jsonb)","application_field_digest(jsonb)","application_field_envelope_ancestry_allowed(uuid,jsonb)","application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])","application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])","application_field_resource_uuid(text)","application_memory_field_keys()","application_memory_field_state(uuid,uuid,text[])","application_memory_field_state_before_successor(uuid,uuid,text[])","application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)","application_memory_history_status(uuid,uuid,text)","application_memory_query_candidate_state(uuid,uuid,text[],jsonb)","application_memory_query_context(uuid)","application_memory_query_domain_state(uuid,uuid,text[])","application_memory_statement_domain(uuid,uuid,text[],jsonb)","application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)","application_memory_statement_helpers_current()","application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)","application_memory_statement_state(uuid,uuid,text[],jsonb)","application_native_catalog_port_valid(regprocedure)","application_native_dependency_batch_helpers_current()","application_native_field_catalog_for(uuid,jsonb,text)","application_native_field_contract_before_catalog(uuid,jsonb,text,text)","application_native_field_contract_for(uuid,jsonb,text,text)","application_native_field_rule_allows(jsonb,text[])","application_native_file_capture_helpers_current()","application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","application_native_member_field_permissions(uuid,jsonb,uuid)","application_native_query_bounds(uuid)","application_native_record_port_valid(regprocedure)","application_native_same_destination(uuid,text,uuid,text,uuid)","application_native_source_edges_dispatch(uuid,text,uuid,text)","application_normalize_native_query_bounds(jsonb)","application_principal_query_bounds(uuid,uuid,boolean)","application_query_scope_cap(integer,jsonb,jsonb)","application_query_scope_intersection(jsonb,jsonb)","application_query_scope_valid(jsonb)","application_query_set_intersection(jsonb,jsonb)","application_reader_envelope_visible(uuid,jsonb)","application_recorded_field_root_capture(uuid,uuid,text,integer)","application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)","application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)","application_scope_lineage(uuid,text[],uuid[],text[])","application_scope_source_edges(uuid,text,uuid,text)","application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)","application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)","application_session_eval_field(uuid,uuid,text,jsonb)","application_session_eval_scope(uuid,text,uuid,text,jsonb)","assistant_placement_visible(uuid,uuid)","capture_native_session_projection_batch(uuid,uuid,integer,text)","crm_capture_erasure_effect()","department_principal_grant_snapshot(uuid)","department_read_grants()","department_read_grants_for(uuid)","department_row_allows(jsonb,uuid,text,text[],uuid)","effective_member_read_compartments(uuid,uuid)","effective_member_team_compartments(uuid,uuid)","enqueue_native_field_dependency_work()","entity_derivation_envelope_valid(jsonb)","guard_application_field_lineage()","guard_external_source_derivation()","guard_page_derivation_receipts()","guard_session_context_lineage()","guard_session_recording_privacy()","guard_workflow_derivation_receipts()","knowledge_version_source_edges(uuid,text,uuid,text)","legacy_assistant_team_compartments(uuid)","member_operation_grants(boolean,uuid)","member_operation_row_allows(jsonb,uuid,text,text[])","member_operation_scope_allows(uuid,text,text[],boolean)","member_principal_operation_grants(uuid,boolean,uuid)","project_member_live(uuid,text,uuid)","read_admitted_native_scope_snapshot(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)","read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)","read_application_field_dependencies(uuid,text[],uuid[],text[])","read_entity_derivation_source(uuid,text,uuid)","read_entity_derivation_source_before_application_fields(uuid,text,uuid)","read_entity_derivation_source_before_blueprint(uuid,text,uuid)","read_entity_derivation_source_before_browser_profile(uuid,text,uuid)","read_entity_derivation_source_before_browser_session(uuid,text,uuid)","read_entity_derivation_source_before_capture(uuid,text,uuid)","read_entity_derivation_source_before_conversation(uuid,text,uuid)","read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)","read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)","read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)","read_entity_derivation_source_before_memory_successor(uuid,text,uuid)","read_entity_derivation_source_before_page(uuid,text,uuid)","read_entity_derivation_source_before_persistent_context(uuid,text,uuid)","read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)","read_entity_derivation_source_before_recordings(uuid,text,uuid)","read_entity_derivation_source_before_workflow_run(uuid,text,uuid)","read_external_source_dependencies(uuid,text[],uuid[],text[])","read_media_parent_snapshot(uuid,text,uuid)","read_media_parent_snapshot_before_blueprint(uuid,text,uuid)","read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)","read_media_parent_snapshot_before_browser_session(uuid,text,uuid)","read_media_parent_snapshot_before_conversation(uuid,text,uuid)","read_media_parent_snapshot_before_page(uuid,text,uuid)","read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)","read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)","read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)","read_native_field_reference_snapshot(uuid,uuid,uuid,text)","read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","read_native_file_session_field_snapshots(uuid,uuid[],text[])","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","read_resource_page_dependencies(uuid,text,uuid,text)","read_scope_source(uuid,text,uuid)","read_scope_source_before_application_fields(uuid,text,uuid)","read_scope_source_before_browser_profile(uuid,text,uuid)","read_scope_source_before_browser_session(uuid,text,uuid)","read_scope_source_before_external(uuid,text,uuid)","read_scope_source_before_knowledge_binding(uuid,text,uuid)","read_scope_source_before_page(uuid,text,uuid)","read_scope_source_before_persistent_context(uuid,text,uuid)","read_scope_source_before_routines(uuid,text,uuid)","read_scope_source_before_workflow_run(uuid,text,uuid)","recording_source_read_allowed(uuid,text,uuid)","refuse_quarantined_recording_message()","scope_review_state_held(text,uuid)","scope_source_ancestors(uuid,text,uuid)","scope_source_ancestors_before_browser_profile(uuid,text,uuid)","scope_source_ancestors_before_browser_session(uuid,text,uuid)","scope_source_ancestors_before_workflow_run(uuid,text,uuid)","scope_source_table(text)","scope_source_table_before_knowledge_versions(text)","scope_source_table_before_media(text)","scope_source_table_before_persistent_context(text)","sensitivity_rank(text)","session_recording_read_allowed(uuid)","validate_application_field_dependencies()","validate_native_field_dependency_batch(uuid,uuid,jsonb)","validate_page_derivation_dependencies()","validate_scope_resource_reference()","validate_workflow_derivation_dependencies()","workflow_evidence_envelope_visible(uuid,jsonb)"]'::jsonb) r(signature);
 IF array_position(member_oids,NULL) IS NOT NULL OR cardinality(member_oids)<>156 THEN RAISE EXCEPTION 'Flat queue prerequisite roster changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
  body:='BEGIN IF (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb THEN RETURN false;END IF; IF (SELECT count(*)='||cardinality(member_oids)||' AND coalesce(bool_and('||comparisons||'),false) FROM (VALUES '||rows_sql||') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;'||own_tables||dependency_tables||'RETURN true;END';
 SELECT * INTO actual FROM pg_proc WHERE oid='public.application_native_field_reference_helpers_current()'::regprocedure;
 IF actual.oid IS NULL OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname']) IS DISTINCT FROM
   '{"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
 IF actual.prosrc IS DISTINCT FROM body THEN RAISE EXCEPTION 'conversation_flat_predecessor_changed: reference';END IF;
END $flat_authentication$;
DO $authenticate_consumers$
DECLARE expected jsonb;actual pg_proc;pin text;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 -- Authenticate legacy writers and the field-dependency adapter outside the
 -- native registry using their complete portable bodies, metadata and grants.
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","pin":"application_native_transcript_prepare_helpers_current()","occurrences":2,"body":"cbfbd9c0b42030d9bf3ef83a7746ab92a222875218f9022df43d2c6d3727c035","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)","pin":"application_native_context_fields_current()","occurrences":6,"body":"c189e8e07eb23055f8047f977f8b54cf7cf7d4aed91e9bcde3261242147d577d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_context_revision","prorows":0,"pronargs":11,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","k","p","i","payload","producer","sources","expected_revision","expected_generation","expected_cursor"],"proargtypes":["2950","2950","25","2950","2950","3802","25","3802","2950","20","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_session_field_dependencies(uuid,text[],uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"2f7b7fbf728e1b675e06b4ffe56ae2ebb159e28e8f59612b0c035de658a1b166","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_personal_title_group_evidence(uuid,uuid[],uuid[])","pin":"application_native_title_acquisition_helpers_current()","occurrences":2,"body":"ebefad7e9e462ebe4103360ed29a2dbea842dd1cbddb43e28382b7ebe33e354d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_personal_title_group_evidence","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","session_ids","revision_ids"],"proargtypes":["2950","2951","2951"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_session_field_snapshots(uuid,uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proargtypes":["2950","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","pin":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","occurrences":0,"body":"90d99f2ba0d20fc32e3ebdeff91d871c43471089e51d74728abc05d3e8cbb30a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_message","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","payload","producer","sources","target"],"proargtypes":["2950","2950","3802","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_covered_session_evidence(uuid,text[],uuid[],text[])","pin":"application_native_covered_evidence_helpers_current()","occurrences":2,"body":"3679d9281b0a9ee7fcf5c61009d991609a495d9e13463aa9254cf40cb1cc83a9","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_covered_session_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)","pin":"application_native_file_capture_helpers_current()","occurrences":3,"body":"9694e162ad1ec7a30259c93bfb1bbe4c079f0d05f33a7b71106c5198c3c4f651","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_query_stage","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t","initial_frame","reader_context"],"proargtypes":["2950","2950","23","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_private_title_acquisition(uuid,uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"ab2abf193e6299125d8f53dc98e07491b9f8f896bb595f4d84743c0e1a7c967b","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_acquisition","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_private_title_evidence(uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"50640d6ba43f914300a89fc2e3aafd111b71a82bb802b248ffb0389731e4c94d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_evidence","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true}]'::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'pin'));
  IF actual.oid IS NULL OR pin IS NULL
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (length(actual.prosrc)-length(replace(actual.prosrc,pin,'')))/64<>(expected->>'occurrences')::integer
   OR encode(sha256(convert_to(replace(actual.prosrc,pin,'__PIN__'),'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT((expected->>'appExecute')::boolean AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'conversation_predecessor_changed: %',expected->>'signature';END IF;
 END LOOP;
END $authenticate_consumers$;
-- A pin in an authenticated body authenticates the complete dependent pg_proc
-- row. Walk only exact fingerprints; never execute catalog code to enroll it.
CREATE TEMP TABLE conversation_authenticated ON COMMIT DROP AS
 WITH RECURSIVE catalog AS MATERIALIZED(
  SELECT p.oid,p.prosrc,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
 ), trusted(oid) AS(
  SELECT to_regprocedure('public.'||signature)::oid FROM native_turn_contract_helpers
  UNION SELECT to_regprocedure('public.'||(value->>'signature'))::oid FROM jsonb_array_elements('[{"signature":"prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","pin":"application_native_transcript_prepare_helpers_current()","occurrences":2,"body":"cbfbd9c0b42030d9bf3ef83a7746ab92a222875218f9022df43d2c6d3727c035","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)","pin":"application_native_context_fields_current()","occurrences":6,"body":"c189e8e07eb23055f8047f977f8b54cf7cf7d4aed91e9bcde3261242147d577d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_context_revision","prorows":0,"pronargs":11,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","k","p","i","payload","producer","sources","expected_revision","expected_generation","expected_cursor"],"proargtypes":["2950","2950","25","2950","2950","3802","25","3802","2950","20","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_session_field_dependencies(uuid,text[],uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"2f7b7fbf728e1b675e06b4ffe56ae2ebb159e28e8f59612b0c035de658a1b166","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_personal_title_group_evidence(uuid,uuid[],uuid[])","pin":"application_native_title_acquisition_helpers_current()","occurrences":2,"body":"ebefad7e9e462ebe4103360ed29a2dbea842dd1cbddb43e28382b7ebe33e354d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_personal_title_group_evidence","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","session_ids","revision_ids"],"proargtypes":["2950","2951","2951"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_session_field_snapshots(uuid,uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proargtypes":["2950","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","pin":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","occurrences":0,"body":"90d99f2ba0d20fc32e3ebdeff91d871c43471089e51d74728abc05d3e8cbb30a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_message","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","payload","producer","sources","target"],"proargtypes":["2950","2950","3802","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_covered_session_evidence(uuid,text[],uuid[],text[])","pin":"application_native_covered_evidence_helpers_current()","occurrences":2,"body":"3679d9281b0a9ee7fcf5c61009d991609a495d9e13463aa9254cf40cb1cc83a9","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_covered_session_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)","pin":"application_native_file_capture_helpers_current()","occurrences":3,"body":"9694e162ad1ec7a30259c93bfb1bbe4c079f0d05f33a7b71106c5198c3c4f651","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_query_stage","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t","initial_frame","reader_context"],"proargtypes":["2950","2950","23","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_private_title_acquisition(uuid,uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"ab2abf193e6299125d8f53dc98e07491b9f8f896bb595f4d84743c0e1a7c967b","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_acquisition","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_private_title_evidence(uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"50640d6ba43f914300a89fc2e3aafd111b71a82bb802b248ffb0389731e4c94d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_evidence","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true}]'::jsonb)
  UNION SELECT p.oid FROM trusted t JOIN catalog caller ON caller.oid=t.oid
   JOIN catalog p ON p.oid=ANY(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(ARRAY['application_empty_query_facades_current()','application_empty_query_helpers_current()','application_memory_statement_helpers_current()','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_file_capture_helpers_current()','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_root_cover(uuid,jsonb)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_worklist_helpers_current()','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','enqueue_native_field_dependency_work()','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_private_title_helpers_current()','native_private_title_proof(uuid,uuid,uuid)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_helpers_current()','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_node_key(jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_private_title_evidence(uuid,uuid)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_revision_allowed(uuid,uuid)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()']::text[]) s))
    AND strpos(caller.prosrc,quote_literal(p.fingerprint))>0
 ) SELECT DISTINCT oid FROM trusted;
INSERT INTO conversation_authenticated SELECT to_regprocedure('public.'||(value->>'signature'))::oid
 FROM jsonb_array_elements('[{"signature":"prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","pin":"application_native_transcript_prepare_helpers_current()","occurrences":2,"body":"cbfbd9c0b42030d9bf3ef83a7746ab92a222875218f9022df43d2c6d3727c035","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)","pin":"application_native_context_fields_current()","occurrences":6,"body":"c189e8e07eb23055f8047f977f8b54cf7cf7d4aed91e9bcde3261242147d577d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_context_revision","prorows":0,"pronargs":11,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","k","p","i","payload","producer","sources","expected_revision","expected_generation","expected_cursor"],"proargtypes":["2950","2950","25","2950","2950","3802","25","3802","2950","20","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_session_field_dependencies(uuid,text[],uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"2f7b7fbf728e1b675e06b4ffe56ae2ebb159e28e8f59612b0c035de658a1b166","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_personal_title_group_evidence(uuid,uuid[],uuid[])","pin":"application_native_title_acquisition_helpers_current()","occurrences":2,"body":"ebefad7e9e462ebe4103360ed29a2dbea842dd1cbddb43e28382b7ebe33e354d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_personal_title_group_evidence","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","session_ids","revision_ids"],"proargtypes":["2950","2951","2951"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_session_field_snapshots(uuid,uuid[],text[])","pin":"native_turn_helpers_current()","occurrences":0,"body":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proargtypes":["2950","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","pin":"publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)","occurrences":0,"body":"90d99f2ba0d20fc32e3ebdeff91d871c43471089e51d74728abc05d3e8cbb30a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"publish_native_session_message","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","payload","producer","sources","target"],"proargtypes":["2950","2950","3802","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"appExecute":true},{"signature":"read_native_covered_session_evidence(uuid,text[],uuid[],text[])","pin":"application_native_covered_evidence_helpers_current()","occurrences":2,"body":"3679d9281b0a9ee7fcf5c61009d991609a495d9e13463aa9254cf40cb1cc83a9","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_covered_session_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)","pin":"application_native_file_capture_helpers_current()","occurrences":3,"body":"9694e162ad1ec7a30259c93bfb1bbe4c079f0d05f33a7b71106c5198c3c4f651","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_query_stage","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t","initial_frame","reader_context"],"proargtypes":["2950","2950","23","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_private_title_acquisition(uuid,uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"ab2abf193e6299125d8f53dc98e07491b9f8f896bb595f4d84743c0e1a7c967b","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_acquisition","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_private_title_evidence(uuid,uuid)","pin":"native_private_title_helpers_current()","occurrences":2,"body":"50640d6ba43f914300a89fc2e3aafd111b71a82bb802b248ffb0389731e4c94d","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_private_title_evidence","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true}]'::jsonb);
INSERT INTO conversation_authenticated VALUES('application_native_dependency_batch_helpers_current()'::regprocedure),('application_native_field_reference_helpers_current()'::regprocedure);
DO $retained_authentication$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid='native_retained_helpers_current()'::regprocedure)
 THEN RAISE EXCEPTION 'conversation_retained_guard_untrusted';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_retained_contract_changed';END IF;
END $retained_authentication$;
INSERT INTO conversation_authenticated SELECT to_regprocedure('public.'||signature)::oid FROM native_retained_contract_helpers;

CREATE TEMP TABLE conversation_reader_contract_members(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $reader_contract_transfer$ DECLARE body text;signature text;members oid[];pin record;tail constant text:=' JOIN pg_catalog.pg_proc p ON p.oid=m.oid);END';BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_reader_contract_changed';END IF;
 SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid='application_memory_statement_helpers_current()'::regprocedure;
 IF strpos(body,' FROM (VALUES ')=0 OR right(body,length(tail))<>tail THEN RAISE EXCEPTION 'conversation_memory_contract_shape';END IF;
 EXECUTE 'SELECT array_agg(m.oid) '||substring(left(body,length(body)-length(tail)) FROM strpos(body,'FROM (VALUES ')) INTO members;
 IF cardinality(members)<>128 THEN RAISE EXCEPTION 'conversation_memory_contract_roster';END IF;
 INSERT INTO conversation_reader_contract_members SELECT unnest(members);
 FOREACH signature IN ARRAY ARRAY['application_native_worklist_helpers_current()','application_empty_query_helpers_current()'] LOOP
  SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=to_regprocedure(signature);
  IF signature='application_empty_query_helpers_current()' AND
   regexp_replace(body,$pattern$\(([0-9]+)::oid,'([a-f0-9]{64})'::text\)$pattern$,'__PIN__','g') IS DISTINCT FROM
   $empty$SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __PIN__,__PIN__,__PIN__,__PIN__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)$empty$
  THEN RAISE EXCEPTION 'conversation_empty_contract_shape';END IF;
  members:='{}';
  FOR pin IN SELECT match[1]::oid oid,match[2] fingerprint FROM regexp_matches(body,$pattern$\(([0-9]+)::oid,'([a-f0-9]{64})'::text\)$pattern$,'g') match LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=pin.oid AND encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint)
   THEN RAISE EXCEPTION 'conversation_reader_leaf_changed';END IF;
   members:=array_append(members,pin.oid);
  END LOOP;
  IF cardinality(members)<>(CASE WHEN signature='application_native_worklist_helpers_current()' THEN 85 ELSE 4 END)
  THEN RAISE EXCEPTION 'conversation_reader_leaf_roster';END IF;
  INSERT INTO conversation_reader_contract_members SELECT unnest(members) ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO conversation_reader_contract_members VALUES('application_empty_query_helpers_current()'::regprocedure) ON CONFLICT DO NOTHING;
 INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p JOIN conversation_reader_contract_members m ON m.oid=p.oid
 ON CONFLICT DO NOTHING;
END $reader_contract_transfer$;

INSERT INTO conversation_authenticated SELECT oid FROM conversation_reader_contract_members;
-- Authenticate the additional old comparator dependencies before propagating
-- the reviewed policy-owner body. No unknown executable is enrolled by calling it.
DO $rule_contract_predecessors$ DECLARE expected jsonb;actual pg_proc;normalized text;pin record;seen text[];body_dependency text;body_pin text;legacy_app_default boolean;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 SELECT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole=owner_id AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype='f'
   AND a.grantor=owner_id AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')
   AND a.privilege_type='EXECUTE' AND NOT a.is_grantable) INTO legacy_app_default;
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"capture_native_session_projection_batch(uuid,uuid,integer,text)","body":"d9a96c70db2140a15f97e81955bbb295ee6f35fa9059d39e958d4af0a04dcf78","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])","application_current_field_snapshot(uuid,uuid)","application_materialize_field_envelope(uuid,jsonb,integer)","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)","read_native_session_field_snapshots(uuid,uuid[],text[])","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)"],"bodyPinHashes":{"observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])":"e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5","application_current_field_snapshot(uuid,uuid)":"06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403","application_materialize_field_envelope(uuid,jsonb,integer)":"6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)":"70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72","read_native_session_field_snapshots(uuid,uuid[],text[])":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)":"50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7"}},{"signature":"scope_source_ancestors(uuid,text,uuid)","body":"cabe0f65f8e31b0123ebe2328d72f314ee1b82795cfa5cf66deb57c792384282","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_external_source_dependencies(uuid,text[],uuid[],text[])","body":"49d22c1cfdb98f6eb0d4421a8c080bebc55b3d843f234d0805968366db4186a2","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_external_source_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_scope_source(uuid,text,uuid)","body":"964be13e8633f714a9df7828421c0d6b1dde0aaff78d3da22b08416d9e6d7aa0","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_scope_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","body":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","body":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_nodes(uuid,jsonb)","body":"fb48ece57a33fa8c9f8e73ffd892b835bcf51d72661f355336590fdf026c17c4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_nodes","prorows":1000,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t"],"proargnames":["w","nodes","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","3802","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","body":"c3de8dda378c2613c0821138a3a9e30b793ff1825ce08d1d73b0ca024d2840de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_cohort_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])"],"bodyPinHashes":{"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd"}},{"signature":"read_admitted_native_scope_snapshot(uuid,text,uuid)","body":"9bb8cbfb739df75d85cfd47d5c6662a1c23808c729c599b6f0479f2b0ebb1a0e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","body":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_memory_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_entity_derivation_source(uuid,text,uuid)","body":"a5ed483e058aa51e2c0bf67a353c6473df18be66687f541cece0146ce14d26e4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"native_private_title_frame(uuid,jsonb)","body":"268610786776c1a90c8703878f3ac39bba77c5d3dae0a3ac630e8c4ea6564ad8","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_frame","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","nodes"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_proof(uuid,uuid,uuid)","body":"8bb2a6087aaf9c62aef680356c929a8f73f846239a042d08763505a9dde8b54e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_proof","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)":"2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376"}},{"signature":"private_transcript_message_fingerprint(session_messages)","body":"bb8dd79fc59b9ecd69574df3694ebfd2a089c305e8ce0dd4e26cca740e387976","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_transcript_message_fingerprint","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp","TimeZone=UTC"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["m"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","body":"6718ca009187e650f1db0f81897c35ced0c7f44fe80b9f8b4eed61f3593c7b5b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_frame_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","frame"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_file_session_field_snapshots(uuid,uuid[],text[])","body":"3a9c531f9216e4ed1099dca7a91006bca2dd0268c5800817aa7daf45aa1e8d37","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"private_legacy_history_binding(sessions)","body":"ede88958a8c91058b31a37cb1fb64c863ee1009027f7afce094f5b38e72a2c21","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_legacy_history_binding","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["s"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_private_transcript_source(uuid,uuid)","body":"0ea4bea3329e6b665a92e25e2077eebb911ea7995c2102357da7aa6bfcc959db","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_private_transcript_source","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_native_file_capture_helpers_current()","body":"4d6230003dd9276cd99a08150efe3831616f9d973c630a849f0b450f1c6af64b","pins":["capture_native_session_projection_batch(uuid,uuid,integer,text)","application_memory_statement_helpers_current()","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","application_empty_query_helpers_current()","read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","read_native_file_session_field_snapshots(uuid,uuid[],text[])"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_capture_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_helpers_current()","body":"f88b16a890b99a1f37e01425236d53a4224a1f6d9fb95bea3d97f5184ed938a7","pins":["scope_source_ancestors(uuid,text,uuid)","read_external_source_dependencies(uuid,text[],uuid[],text[])","read_scope_source(uuid,text,uuid)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_nodes(uuid,jsonb)","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","read_admitted_native_scope_snapshot(uuid,text,uuid)","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_entity_derivation_source(uuid,text,uuid)","application_memory_statement_helpers_current()","application_empty_query_helpers_current()","application_native_worklist_helpers_current()","private_legacy_history_binding(sessions)","private_transcript_message_fingerprint(session_messages)","read_private_transcript_source(uuid,uuid)","native_private_title_frame(uuid,jsonb)","native_private_title_proof(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"session_context_file_revision_allowed(uuid,uuid)","body":"a36f3c1440dfa1dad87d5005c312ed2da5bf7d3c30e16bc1383c53f53c2e57de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_file_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_file_revision(uuid,uuid)","body":"334acdc238b0782d7e204515f484e5e06ef6fdb03e59aeddd5ef99256dda369b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_file_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_file_session_title_revision(uuid,uuid,uuid)","body":"1efd74ded55c70183f4ca90bb03cbb356bcc35314961a8d61b88ef18a5a3a735","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_evidence(uuid,text[],uuid[],text[])","body":"632a73985ec9520a5e45a8446e13ff1774f2649e6ab65e49f9a8a43fee96582d","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"session_context_empty_query_revision_allowed(uuid,uuid)","body":"5deac1df7e9ec71e048008785aa494ec0eb7dd01bba1373e0256016754562f91","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_empty_query_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_empty_query_revision(uuid,uuid)","body":"c2663c2d85c3b0dcc168da40b1fc016f9e4837f7efd4412d9a5afbbf15845b72","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_empty_query_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_session_title_revision(uuid,uuid,uuid)","body":"5ba7b7a004054b73d36298a3a7c8384e3fc27f0e6ad5e55ed590af482465925b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"application_empty_query_facades_current()","body":"121051c87b62aa66642347a6d428951ea02a5cc7bd13af325be0cb0825d11739","pins":["session_context_file_revision_allowed(uuid,uuid)","read_session_context_file_revision(uuid,uuid)","read_native_file_session_title_revision(uuid,uuid,uuid)","application_empty_query_helpers_current()","read_native_empty_query_evidence(uuid,text[],uuid[],text[])","session_context_empty_query_revision_allowed(uuid,uuid)","read_session_context_empty_query_revision(uuid,uuid)","read_native_empty_query_session_title_revision(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_empty_query_facades_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false}]'::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  normalized:=actual.prosrc;seen:='{}';
  IF jsonb_array_length(expected->'pins')>0 THEN
   FOR pin IN SELECT match[1]::oid oid,match[2] fingerprint FROM regexp_matches(normalized,$pattern$\(([0-9]+)::oid,'([a-f0-9]{64})'::text\)$pattern$,'g') match LOOP
    IF NOT EXISTS(SELECT 1 FROM conversation_authenticated a JOIN pg_proc p ON p.oid=a.oid WHERE p.oid=pin.oid
     AND encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint)
    THEN RAISE EXCEPTION 'conversation_rule_leaf_untrusted: %',pin.oid::regprocedure;END IF;
    seen:=array_append(seen,pin.oid::regprocedure::text);
   END LOOP;
   normalized:=regexp_replace(normalized,$pattern$\(([0-9]+)::oid,'([a-f0-9]{64})'::text\)$pattern$,'__PIN__','g');
  END IF;
  -- Raw-body pins vary with already-authenticated dependency catalogs.
  -- Normalize only reviewed identities; their actual bodies remain checked.
  FOR body_dependency IN SELECT jsonb_array_elements_text(coalesce(expected->'bodyPins','[]')) LOOP
   SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO body_pin FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.'||body_dependency);
   IF body_pin IS NULL OR strpos(normalized,quote_literal(body_pin))=0
    OR NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid=to_regprocedure('public.'||body_dependency))
     AND body_pin IS DISTINCT FROM expected#>>ARRAY['bodyPinHashes',body_dependency]
   THEN RAISE EXCEPTION 'conversation_rule_body_dependency_changed: %',body_dependency;END IF;
   normalized:=replace(normalized,quote_literal(body_pin),quote_literal('__BODY_PIN:'||body_dependency||'__'));
  END LOOP;
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl','proargtypes']) IS DISTINCT FROM expected->'metadata'
   OR encode(sha256(convert_to(normalized,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR to_jsonb(seen) IS DISTINCT FROM expected->'pins'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT(((expected->>'appExecute')::boolean OR legacy_app_default) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'conversation_rule_predecessor_changed: %',expected->>'signature';END IF;
  INSERT INTO conversation_authenticated VALUES(actual.oid);
 END LOOP;
END $rule_contract_predecessors$;

-- Preserve the authenticated comparator executable and its exact leaf roster.
-- Rebuild only typed catalog-row literals; nested bodies cannot be repaired by
-- global fingerprint substitution without changing another comparator's data.
CREATE TEMP TABLE conversation_contract_predicates(predicate text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE conversation_flat_contracts(oid oid PRIMARY KEY,prefix text,suffix text,members oid[]) ON COMMIT DROP;
DO $flat_contracts$ DECLARE signature text;body text;begin_at integer;end_at integer;join_at integer;members oid[];ok boolean;tail text;condition text;ending constant text:=' THEN RETURN false;END IF;';BEGIN
 FOREACH signature IN ARRAY ARRAY['application_memory_statement_helpers_current()',
  'application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()',
  'application_native_covered_evidence_helpers_current()'] LOOP
  IF NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid=to_regprocedure(signature))
  THEN RAISE EXCEPTION 'conversation_flat_contract_untrusted: %',signature;END IF;
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'conversation_flat_contract_changed: %',signature;END IF;
  SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=to_regprocedure(signature);
  begin_at:=strpos(body,'FROM (VALUES ')+length('FROM (VALUES ');
  end_at:=length(body)-strpos(reverse(body),reverse(') m(oid,'))-length(') m(oid,')+2;
  join_at:=length(body)-strpos(reverse(body),reverse(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid'))-length(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid')+2;
  IF begin_at<=length('FROM (VALUES ') OR end_at<begin_at OR join_at<end_at
  THEN RAISE EXCEPTION 'conversation_flat_contract_shape: %',signature;END IF;
  EXECUTE 'SELECT array_agg(m.oid ORDER BY m.oid) FROM (VALUES '||substring(body FROM begin_at FOR join_at-begin_at) INTO members;
  IF members IS NULL OR cardinality(members)<>cardinality(ARRAY(SELECT DISTINCT unnest(members)))
  THEN RAISE EXCEPTION 'conversation_flat_contract_roster: %',signature;END IF;
  INSERT INTO conversation_flat_contracts VALUES(to_regprocedure(signature),left(body,begin_at-1),substring(body FROM end_at),members);
  INSERT INTO conversation_authenticated SELECT unnest(members);
  INSERT INTO native_turn_contract_helpers(signature,fingerprint)
   SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=ANY(members) ON CONFLICT DO NOTHING;
  -- Transfer non-function predicates verbatim from the authenticated comparator.
  tail:=substring(body FROM join_at+length(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid)'));
  IF signature IN('application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()') THEN
   IF left(tail,length(' IS NOT TRUE THEN RETURN false;END IF;'))<>' IS NOT TRUE THEN RETURN false;END IF;'
   THEN RAISE EXCEPTION 'conversation_table_contract_shape';END IF;
   tail:=substring(tail FROM length(' IS NOT TRUE THEN RETURN false;END IF;')+1);
   WHILE left(ltrim(tail,E' 
'),3)='IF ' LOOP
    tail:=substring(ltrim(tail,E' 
') FROM 4);
    IF strpos(tail,ending)=0 THEN RAISE EXCEPTION 'conversation_table_contract_shape';END IF;
    condition:=left(tail,strpos(tail,ending)-1);
    INSERT INTO conversation_contract_predicates VALUES('NOT('||condition||')');
    tail:=substring(tail FROM strpos(tail,ending)+length(ending));
   END LOOP;
   IF btrim(tail,E' 
')<>'RETURN true;END' THEN RAISE EXCEPTION 'conversation_table_contract_tail';END IF;
  ELSIF tail<>';END' THEN RAISE EXCEPTION 'conversation_table_contract_tail';END IF;
 END LOOP;
END $flat_contracts$;
CREATE TEMP TABLE conversation_before ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) metadata,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
 FROM pg_proc p WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(ARRAY['application_empty_query_facades_current()','application_empty_query_helpers_current()','application_memory_statement_helpers_current()','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_file_capture_helpers_current()','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_root_cover(uuid,jsonb)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_worklist_helpers_current()','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','enqueue_native_field_dependency_work()','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_private_title_helpers_current()','native_private_title_proof(uuid,uuid,uuid)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_helpers_current()','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_node_key(jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_private_title_evidence(uuid,uuid)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_revision_allowed(uuid,uuid)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()']::text[]) s));
DO $roster$ BEGIN
 IF (SELECT count(*) FROM conversation_before)<>129
  OR EXISTS(SELECT 1 FROM conversation_before b WHERE NOT EXISTS(SELECT 1 FROM conversation_authenticated a WHERE a.oid=b.oid))
 THEN RAISE EXCEPTION 'conversation_untrusted_consumer' USING DETAIL=(SELECT string_agg(b.signature,',') FROM conversation_before b WHERE NOT EXISTS(SELECT 1 FROM conversation_authenticated a WHERE a.oid=b.oid));END IF;
END $roster$;
-- Only exact known private functions with an authenticated legacy default ACL
-- reach here. Capture their old rows first so all callers are repinned below.
DO $private_rule_acl$ DECLARE expected jsonb;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"capture_native_session_projection_batch(uuid,uuid,integer,text)","body":"d9a96c70db2140a15f97e81955bbb295ee6f35fa9059d39e958d4af0a04dcf78","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])","application_current_field_snapshot(uuid,uuid)","application_materialize_field_envelope(uuid,jsonb,integer)","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)","read_native_session_field_snapshots(uuid,uuid[],text[])","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)"],"bodyPinHashes":{"observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])":"e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5","application_current_field_snapshot(uuid,uuid)":"06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403","application_materialize_field_envelope(uuid,jsonb,integer)":"6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)":"70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72","read_native_session_field_snapshots(uuid,uuid[],text[])":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)":"50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7"}},{"signature":"scope_source_ancestors(uuid,text,uuid)","body":"cabe0f65f8e31b0123ebe2328d72f314ee1b82795cfa5cf66deb57c792384282","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_external_source_dependencies(uuid,text[],uuid[],text[])","body":"49d22c1cfdb98f6eb0d4421a8c080bebc55b3d843f234d0805968366db4186a2","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_external_source_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_scope_source(uuid,text,uuid)","body":"964be13e8633f714a9df7828421c0d6b1dde0aaff78d3da22b08416d9e6d7aa0","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_scope_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","body":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","body":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_nodes(uuid,jsonb)","body":"fb48ece57a33fa8c9f8e73ffd892b835bcf51d72661f355336590fdf026c17c4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_nodes","prorows":1000,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t"],"proargnames":["w","nodes","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","3802","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","body":"c3de8dda378c2613c0821138a3a9e30b793ff1825ce08d1d73b0ca024d2840de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_cohort_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])"],"bodyPinHashes":{"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd"}},{"signature":"read_admitted_native_scope_snapshot(uuid,text,uuid)","body":"9bb8cbfb739df75d85cfd47d5c6662a1c23808c729c599b6f0479f2b0ebb1a0e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","body":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_memory_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_entity_derivation_source(uuid,text,uuid)","body":"a5ed483e058aa51e2c0bf67a353c6473df18be66687f541cece0146ce14d26e4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"native_private_title_frame(uuid,jsonb)","body":"268610786776c1a90c8703878f3ac39bba77c5d3dae0a3ac630e8c4ea6564ad8","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_frame","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","nodes"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_proof(uuid,uuid,uuid)","body":"8bb2a6087aaf9c62aef680356c929a8f73f846239a042d08763505a9dde8b54e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_proof","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)":"2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376"}},{"signature":"private_transcript_message_fingerprint(session_messages)","body":"bb8dd79fc59b9ecd69574df3694ebfd2a089c305e8ce0dd4e26cca740e387976","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_transcript_message_fingerprint","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp","TimeZone=UTC"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["m"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","body":"6718ca009187e650f1db0f81897c35ced0c7f44fe80b9f8b4eed61f3593c7b5b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_frame_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","frame"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_file_session_field_snapshots(uuid,uuid[],text[])","body":"3a9c531f9216e4ed1099dca7a91006bca2dd0268c5800817aa7daf45aa1e8d37","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"private_legacy_history_binding(sessions)","body":"ede88958a8c91058b31a37cb1fb64c863ee1009027f7afce094f5b38e72a2c21","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_legacy_history_binding","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["s"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_private_transcript_source(uuid,uuid)","body":"0ea4bea3329e6b665a92e25e2077eebb911ea7995c2102357da7aa6bfcc959db","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_private_transcript_source","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_native_file_capture_helpers_current()","body":"4d6230003dd9276cd99a08150efe3831616f9d973c630a849f0b450f1c6af64b","pins":["capture_native_session_projection_batch(uuid,uuid,integer,text)","application_memory_statement_helpers_current()","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","application_empty_query_helpers_current()","read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","read_native_file_session_field_snapshots(uuid,uuid[],text[])"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_capture_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_helpers_current()","body":"f88b16a890b99a1f37e01425236d53a4224a1f6d9fb95bea3d97f5184ed938a7","pins":["scope_source_ancestors(uuid,text,uuid)","read_external_source_dependencies(uuid,text[],uuid[],text[])","read_scope_source(uuid,text,uuid)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_nodes(uuid,jsonb)","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","read_admitted_native_scope_snapshot(uuid,text,uuid)","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_entity_derivation_source(uuid,text,uuid)","application_memory_statement_helpers_current()","application_empty_query_helpers_current()","application_native_worklist_helpers_current()","private_legacy_history_binding(sessions)","private_transcript_message_fingerprint(session_messages)","read_private_transcript_source(uuid,uuid)","native_private_title_frame(uuid,jsonb)","native_private_title_proof(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"session_context_file_revision_allowed(uuid,uuid)","body":"a36f3c1440dfa1dad87d5005c312ed2da5bf7d3c30e16bc1383c53f53c2e57de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_file_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_file_revision(uuid,uuid)","body":"334acdc238b0782d7e204515f484e5e06ef6fdb03e59aeddd5ef99256dda369b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_file_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_file_session_title_revision(uuid,uuid,uuid)","body":"1efd74ded55c70183f4ca90bb03cbb356bcc35314961a8d61b88ef18a5a3a735","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_evidence(uuid,text[],uuid[],text[])","body":"632a73985ec9520a5e45a8446e13ff1774f2649e6ab65e49f9a8a43fee96582d","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"session_context_empty_query_revision_allowed(uuid,uuid)","body":"5deac1df7e9ec71e048008785aa494ec0eb7dd01bba1373e0256016754562f91","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_empty_query_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_empty_query_revision(uuid,uuid)","body":"c2663c2d85c3b0dcc168da40b1fc016f9e4837f7efd4412d9a5afbbf15845b72","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_empty_query_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_session_title_revision(uuid,uuid,uuid)","body":"5ba7b7a004054b73d36298a3a7c8384e3fc27f0e6ad5e55ed590af482465925b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"application_empty_query_facades_current()","body":"121051c87b62aa66642347a6d428951ea02a5cc7bd13af325be0cb0825d11739","pins":["session_context_file_revision_allowed(uuid,uuid)","read_session_context_file_revision(uuid,uuid)","read_native_file_session_title_revision(uuid,uuid,uuid)","application_empty_query_helpers_current()","read_native_empty_query_evidence(uuid,text[],uuid[],text[])","session_context_empty_query_revision_allowed(uuid,uuid)","read_session_context_empty_query_revision(uuid,uuid)","read_native_empty_query_session_title_revision(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_empty_query_facades_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false}]'::jsonb) WHERE (value->>'appExecute')::boolean IS FALSE LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure('public.'||(expected->>'signature')) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user'))
  THEN EXECUTE 'REVOKE ALL ON FUNCTION public.'||(expected->>'signature')||' FROM app_user';END IF;
 END LOOP;
END $private_rule_acl$;



CREATE TEMP TABLE conversation_constraint_before ON COMMIT DROP AS
 SELECT to_jsonb(c) metadata FROM pg_constraint c WHERE conrelid='native_turn_frames'::regclass AND conname='native_turn_frames_format_check';
ALTER TABLE native_turn_publication_work ADD COLUMN completion_owner uuid;
ALTER TABLE native_turn_frames DROP CONSTRAINT native_turn_frames_format_check;
ALTER TABLE native_turn_frames ADD CONSTRAINT native_turn_frames_format_check CHECK(format IN(1,2));
DO $replace$ DECLARE pin text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='application_native_context_fields_current()'::regprocedure;
 EXECUTE replace($sources$-- [COMP:security/native-field-policy] One rule evaluation per physical mask operation.
CREATE OR REPLACE FUNCTION application_native_member_field_permissions(w uuid,policy jsonb,member_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roles text[]; result jsonb; metadata jsonb:=policy->'metadata';
BEGIN
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=member_id) THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(DISTINCT a.role_key),'{}') INTO roles FROM application_native_role_assignments a
  WHERE a.workspace_id=w AND a.module_key=metadata->>'moduleKey' AND a.user_id=member_id AND a.status='active'
   AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) AND (policy->'roleKeys') ? a.role_key;
 -- Fields reference rules; they are not separate permission operations. Evaluate
 -- each distinct rule under these current roles, then project the original keys.
 -- All state is statement-local. The next invocation reads roles again.
 WITH fields AS MATERIALIZED(SELECT value FROM jsonb_array_elements(metadata->'fields')),
 rules AS(SELECT value->'read' rule FROM fields UNION SELECT value->'write' FROM fields),
 decisions AS MATERIALIZED(SELECT rule,application_native_field_rule_allows(rule,roles) allowed FROM rules)
 SELECT jsonb_build_object(
  'read',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'read' WHERE d.allowed ORDER BY 1),
  'write',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'write' WHERE d.allowed ORDER BY 1)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION application_native_member_field_permissions(uuid,jsonb,uuid) FROM PUBLIC;

-- [COMP:api/authority-lease] Retire the unconsumed action-snapshot notification path.
-- Historical migration 8208 stays immutable. Unknown dependents fail RESTRICT.
DO $retire_snapshot_events$
DECLARE item record; owner_id oid; helper oid:=to_regprocedure('public.notify_permission_snapshot_event()');
BEGIN
 SELECT oid INTO owner_id FROM pg_roles WHERE rolname=current_user;
 IF helper IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=helper AND p.proowner=owner_id
  AND p.prorettype='trigger'::regtype AND p.prosecdef
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='897264c9e446071d0f868305d932f82902caae1b80369eddc4ab847d2eca4472') THEN
  RAISE EXCEPTION 'conversation_snapshot_notification_predecessor_changed';END IF;
 FOR item IN SELECT * FROM (VALUES
  ('application_policy_workspace_epochs','permission_snapshot_workspace_event',29),
  ('application_policy_contract_epoch','permission_snapshot_contract_event',28),
  ('application_policy_workspace_epochs','permission_snapshot_workspace_truncate',32),
  ('application_policy_contract_epoch','permission_snapshot_contract_truncate',32)) expected(relation,name,kind) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||item.relation)
   AND t.tgname=item.name AND t.tgfoid=helper AND t.tgtype=item.kind AND NOT t.tgisinternal
   AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgnargs=0) THEN
   RAISE EXCEPTION 'conversation_snapshot_notification_trigger_changed';END IF;
  EXECUTE format('DROP TRIGGER %I ON public.%I',item.name,item.relation);
 END LOOP;
END $retire_snapshot_events$;
DROP FUNCTION public.notify_permission_snapshot_event() RESTRICT;

-- [COMP:api/authority-lease] One canonical owner for fresh session metadata.
CREATE FUNCTION read_session_department_facts(uuid,uuid,uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $facts$
WITH member AS MATERIALIZED (
    SELECT role, clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2
  ), active_projects AS MATERIALIZED (
    SELECT s.project_id FROM project_shared_scopes s JOIN workspaces w ON w.id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.status='active' AND w.project_shared_spaces
  ) SELECT jsonb_build_object(
    'member', (SELECT to_jsonb(m) FROM member m),
    'assistant', (SELECT jsonb_build_object('clearance',a.clearance) FROM assistants a
      WHERE a.id=$3 AND a.workspace_id=$1 AND public.assistant_placement_visible($2,a.id)),
    'edges', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind',e.principal_kind,'id',coalesce(e.user_id,e.assistant_id),
      'departmentId',e.department_id,'clearance',e.clearance,'expiresAt',e.expires_at))
      FROM department_edges e WHERE e.workspace_id=$1
        AND ((e.user_id=$2 AND EXISTS(SELECT 1 FROM member)) OR e.assistant_id=$3)), '[]'::jsonb),
    'activeProjects', coalesce((SELECT jsonb_agg(project_id ORDER BY project_id) FROM active_projects), '[]'::jsonb),
    'projectEdges', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind',e.principal_kind,'id',coalesce(e.user_id,e.assistant_id),
      'projectId',e.project_id,'expiresAt',e.expires_at))
      FROM project_shared_members e WHERE e.workspace_id=$1 AND EXISTS(SELECT 1 FROM active_projects)
        AND ((e.user_id=$2 AND EXISTS(SELECT 1 FROM member)) OR e.assistant_id=$3)), '[]'::jsonb)
    ) AS snapshot
$facts$;
REVOKE ALL ON FUNCTION read_session_department_facts(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_session_department_facts(uuid,uuid,uuid) TO app_user;
CREATE FUNCTION read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $facts$
SELECT jsonb_build_object(
    'scope', jsonb_build_object(
      'assignedTeams', coalesce((SELECT jsonb_agg(jsonb_build_object('readAll',g.read_all,'own',g.compartment_key,'grant',cg.compartment_key))
        FROM workspace_group_assistants ga JOIN workspace_groups g ON g.id=ga.group_id
        LEFT JOIN workspace_group_compartment_grants cg ON cg.group_id=g.id
        WHERE ga.assistant_id=$3 AND g.workspace_id=$1 AND g.kind='team'
          AND EXISTS(SELECT 1 FROM assistants WHERE id=$3 AND team_scope_mode='assigned')), '[]'::jsonb),
      'assignedProjects', coalesce((SELECT jsonb_agg(p.id ORDER BY p.id) FROM assistant_project_grants apg
        JOIN workspace_projects p ON p.id=apg.project_id WHERE apg.assistant_id=$3 AND p.workspace_id=$1
          AND EXISTS(SELECT 1 FROM assistants WHERE id=$3 AND project_scope_mode='assigned')), '[]'::jsonb),
      'team', (SELECT jsonb_build_object('id',g.id,'name',g.name,'key',g.key,'compartmentKey',g.compartment_key,
        'status',g.status,'readAll',g.read_all,'grants',coalesce((SELECT jsonb_agg(cg.compartment_key ORDER BY cg.compartment_key)
          FROM workspace_group_compartment_grants cg WHERE cg.group_id=g.id),'[]'::jsonb))
        FROM workspace_groups g JOIN sessions s ON s.context_group_id=g.id
        WHERE s.id=$4 AND g.workspace_id=$1 AND g.kind='team'),
      'project', (SELECT jsonb_build_object('id',p.id,'name',p.name,'status',p.status,
        'shared',EXISTS(SELECT 1 FROM project_shared_scopes ps WHERE ps.project_id=p.id))
        FROM workspace_projects p JOIN sessions s ON s.context_project_id=p.id WHERE s.id=$4 AND p.workspace_id=$1)),
    'policy', CASE WHEN $9::boolean THEN public.read_application_policy_epoch($1,$2,$3) ELSE NULL END,
    'session', (SELECT jsonb_build_object('id',s.id,'assistantId',s.assistant_id,'userId',s.user_id,
      'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,'contextLockedAt',s.context_locked_at,'appOrigin',s.app_origin,'anchorKind',s.anchor_kind,'anchorRef',s.anchor_ref,'channelType',s.channel_type,'channelId',s.channel_id,
      'visibility',s.visibility,'mode',s.mode,'effectiveClearance',s.effective_clearance,'contextCompartments',s.context_compartments)
      FROM sessions s WHERE s.id=$4 AND session_recording_read_allowed(s.id)),
    'assistant', (SELECT jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'kind',a.kind,
      'clearance',a.clearance,'compartments',a.compartments,'defaultCompartments',a.default_compartments,
      'teamScopeMode',a.team_scope_mode,'defaultWorkspaceGroupId',a.default_workspace_group_id,
      'projectScopeMode',a.project_scope_mode,'defaultProjectId',a.default_project_id)
      FROM assistants a WHERE a.id=$3),
    'member', (SELECT jsonb_build_object('role',m.role,'clearance',m.clearance,
      'readCompartments',effective_member_read_compartments(m.user_id,m.workspace_id),
      'mutationCompartments',effective_member_team_compartments(m.user_id,m.workspace_id),
      'departmentReadV2',(SELECT to_jsonb(w)->>'department_read_v2' FROM workspaces w WHERE w.id=$1))
      FROM workspace_members m WHERE m.workspace_id=$1 AND m.user_id=$2),
    'department', CASE WHEN $8::boolean AND EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND department_read_v2)
      THEN (SELECT snapshot FROM (SELECT read_session_department_facts($1,$2,$3) AS snapshot) department_facts) ELSE NULL END,
    'credentialCurrent', CASE WHEN $5::uuid IS NULL THEN true ELSE $7::uuid=$2 AND EXISTS(
      SELECT 1 FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$2 AND u.auth_version=$6 AND s.id=$5 AND s.auth_version=$6
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) END
    ) AS facts
$facts$;
REVOKE ALL ON FUNCTION read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean) FROM PUBLIC;

-- [COMP:api/native-turn-frame] All canonical prepared field families share one reference gate.
-- The predecessor was authenticated before replacement. Keep its operation,
-- context, contract and exact observation checks; remove the retired writer's
-- conversation/Memory-only selector restriction.
DO $field_reference$
DECLARE definition text;restriction text:=$old$ AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND f.type_key IN('session_message','session_message_annotation','memory') AND f.selection IN('read','query','identity','query_domain') AND f.selected_version IS NULL$old$;
BEGIN
 definition:=pg_get_functiondef('native_turn_field_reference(uuid,uuid,uuid,text)'::regprocedure);
 IF strpos(definition,restriction)=0 THEN RAISE EXCEPTION 'conversation_field_reference_predecessor_changed';END IF;
 EXECUTE replace(definition,restriction,'');
END $field_reference$;

-- [COMP:api/native-turn-frame] Canonical publication owns scheduling and completion.
-- All predecessor executables/table contracts were authenticated by the installer.
LOCK TABLE public.native_field_dependency_work,public.native_field_dependency_batches IN ACCESS EXCLUSIVE MODE;
DO $empty_old_work$ BEGIN
 IF EXISTS(SELECT 1 FROM native_field_dependency_work) OR EXISTS(SELECT 1 FROM native_field_dependency_batches)
 THEN RAISE EXCEPTION 'conversation_legacy_field_work_not_empty';END IF;
END $empty_old_work$;
DO $per_event_constraint$ DECLARE definition text;body text;prefix text;original text;begin_at integer;end_at integer;native_event text;
 marker constant text:=' FOR work_row IN SELECT * FROM jsonb_populate_recordset(NULL::scope_derivation_sources,coalesce(work_rows,''[]'')) LOOP';
BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO STRICT definition,body FROM pg_proc WHERE oid='validate_application_field_dependencies()'::regprocedure;
 begin_at:=strpos(body,marker);end_at:=strpos(body,' END LOOP original_work;');
 IF begin_at=0 OR end_at<=begin_at OR strpos(body,' work_row scope_derivation_sources;')=0
  OR strpos(body,' work_rows:=jsonb_build_array(to_jsonb(NEW));')=0
 THEN RAISE EXCEPTION 'conversation_generic_constraint_predecessor_changed';END IF;
 prefix:=left(body,strpos(body,' work_row scope_derivation_sources;')-1);
 native_event:=substring(body FROM strpos(body,E'BEGIN\n')+length(E'BEGIN\n') FOR strpos(body,' work_rows:=jsonb_build_array(to_jsonb(NEW));')-strpos(body,E'BEGIN\n')-length(E'BEGIN\n'));
 original:=substring(body FROM begin_at+length(marker) FOR end_at-begin_at-length(marker));
 original:=replace(replace(original,'work_row.','NEW.'),'CONTINUE original_work;','RETURN NULL;');
 EXECUTE replace(definition,body,prefix||E'BEGIN\n'||native_event||original||E'\n RETURN NULL;\nEND');
END $per_event_constraint$;
DO $remove_specialized_reference$ DECLARE definition text;old_branch constant text:=$old$  IF source_row IS NULL AND TG_RELID='public.scope_derivation_sources'::regclass AND TG_OP='INSERT' AND expected_kind='application_field' THEN
    IF application_native_field_reference_helpers_current() IS TRUE THEN
      source_row:=read_native_field_reference_snapshot(NEW.workspace_id,NEW.derivation_id,expected_id,expected_version);
    END IF;
  END IF;
$old$;
BEGIN
 definition:=pg_get_functiondef('validate_scope_resource_reference()'::regprocedure);
 IF strpos(definition,old_branch)=0 THEN RAISE EXCEPTION 'conversation_reference_fallback_predecessor_changed';END IF;
 EXECUTE replace(definition,old_branch,'');
END $remove_specialized_reference$;
CREATE FUNCTION public.native_turn_capture_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
BEGIN
 -- Only the canonical collector may claim this event. Unowned events retain
 -- the generic named constraint's complete fresh per-event validation.
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid='native_turn_capture_event(jsonb)'::regprocedure)='__CONVERSATION_EVENT_FINGERPRINT__'
 THEN PERFORM native_turn_capture_event(to_jsonb(NEW));END IF;
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.native_turn_capture_event() FROM PUBLIC,app_user;
DO $event_collector_pin$ DECLARE definition text;pin text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_capture_event(jsonb)'::regprocedure;
 definition:=pg_get_functiondef('native_turn_capture_event()'::regprocedure);
 EXECUTE replace(definition,'__CONVERSATION_EVENT_FINGERPRINT__',pin);
END $event_collector_pin$;
DROP TRIGGER application_field_dependency_work ON public.scope_derivation_sources;
-- PostgreSQL fires same-kind triggers by name. Collect before the unchanged
-- application_field_derivation_dependencies constraint even in IMMEDIATE mode.
CREATE TRIGGER application_field_capture AFTER INSERT OR UPDATE ON public.scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION public.native_turn_capture_event();

-- [COMP:api/native-turn-frame] Remove native reader probing; preserve history-purpose qualification.
CREATE OR REPLACE FUNCTION public.read_native_session_field_dependencies(w uuid, kinds text[], ids uuid[], versions text[])
 RETURNS TABLE(node_version text, source jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;position integer;
 resource application_field_resources;observation application_field_observations;proof jsonb;history_snapshot jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;child_kinds text[];child_ids uuid[];child_versions text[];
 eligible boolean;eligible_roots jsonb:='{}';root_shape jsonb;
 wrapper_position integer;current_envelope jsonb;child jsonb;wrapper_rows jsonb;wrapper_row jsonb;frozen application_query_domains;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean;
 observed_sources jsonb;expected_sources jsonb;delegated jsonb;wrapper_source jsonb;
BEGIN
 -- Native titles and canonical turn frames delegate their complete stored field roots.
 -- Only a verified frame may carry the original Memory history purpose.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND (actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))) THEN
  FOR position IN 1..cardinality(ids) LOOP
   IF kinds[position]<>'session_context_revision' THEN CONTINUE;END IF;

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=ids[position] AND r.scope_version=1
  AND (r.parent_kind='session_title' AND r.parent_id=r.session_id
   OR r.parent_kind='turn_frame' AND r.parent_id=r.id AND EXISTS(SELECT 1 FROM native_turn_frames frame
    WHERE frame.workspace_id=w AND frame.id=r.id AND frame.session_id=r.session_id AND frame.format=2));
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

   IF eligible IS TRUE THEN
    eligible_roots:=eligible_roots||jsonb_build_object(position::text,jsonb_build_object('kinds',child_kinds,'ids',child_ids,'versions',child_versions));
   END IF;
  END LOOP;
  IF eligible_roots<>'{}'::jsonb THEN
   FOR position IN 1..cardinality(ids) LOOP
    root_shape:=eligible_roots->position::text;
    IF root_shape IS NULL THEN
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    ELSE
     IF versions[position] IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     IF EXISTS(SELECT 1 FROM native_turn_frames frame WHERE frame.workspace_id=w AND frame.id=ids[position] AND frame.format=2) THEN
      IF native_turn_helpers_current() IS NOT TRUE OR native_turn_frame_pair(w,ids[position]) IS NOT TRUE THEN
       RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
      memo:=conversation_dag(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',ids[position],'version','1')),'[]');
      IF memo#>>ARRAY['native:session_context_revision:'||ids[position]||':1','value'] IS DISTINCT FROM 'true' THEN
       RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     ELSIF session_context_revision_allowed(w,ids[position]) IS NOT TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     SELECT array_agg(value) INTO child_kinds FROM jsonb_array_elements_text(root_shape->'kinds');
     SELECT array_agg(value::uuid) INTO child_ids FROM jsonb_array_elements_text(root_shape->'ids');
     SELECT array_agg(value) INTO child_versions FROM jsonb_array_elements_text(root_shape->'versions');
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;

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
   history_snapshot:=admitted;
   proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
   IF proof IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f
      WHERE f->>'id'=dependency.source->>'resourceId' AND f->>'version'=dependency.node_version)
     AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) r(kind,id,version) WHERE r.kind='application_field'
      AND r.id=(dependency.source->>'resourceId')::uuid AND r.version=dependency.node_version) THEN CONTINUE;END IF;
    IF dependency.source->>'resourceKind'='application_field' AND dependency.source->>'resourceId'=ids[position]::text
     AND dependency.node_version=versions[position] THEN
     -- This exact root was canonically admitted after the caller's metadata discovery.
     IF dependency.source IS DISTINCT FROM (history_snapshot-ARRAY['held','validTo','retractedAt'])
      OR scope_review_state_held('application_field',ids[position]) IS TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    ELSE
     result:=application_session_eval_field(w,(dependency.source->>'resourceId')::uuid,dependency.node_version,memo);
     memo:=coalesce(result->'memo',memo);admitted:=result->'value';
     IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END IF;
    node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
   END LOOP;
  END LOOP;
  RETURN;
 END IF;
 -- Typed native session wrappers preserve their own immutable binding and all original roots.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  wrapper_rows:='{}';
  FOR wrapper_position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources f WHERE f.workspace_id=w AND f.id=ids[wrapper_position]
    AND kinds[wrapper_position]='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}'
    AND f.type_key='session_message' AND f.selected_version IS NULL AND f.selection IN('read','query','identity','query_domain');
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]) n
    JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
     AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN CONTINUE;END IF;
   history_shape:=false;
   IF resource.selection<>'query_domain' THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources link ON link.workspace_id=d.workspace_id AND link.derivation_id=d.id
 CROSS JOIN LATERAL (
  SELECT link.source_kind,link.source_id,link.source_version WHERE link.source_kind<>'session_context_revision'
  UNION ALL
  SELECT edge.source_kind,edge.source_id,edge.source_version FROM native_turn_frames frame
   JOIN scope_derivations declaration ON declaration.workspace_id=frame.workspace_id
    AND declaration.resource_kind='session_context_revision' AND declaration.resource_id=frame.id AND declaration.resource_version='1'
   JOIN scope_derivation_sources edge ON edge.workspace_id=declaration.workspace_id AND edge.derivation_id=declaration.id
   WHERE link.source_kind='session_context_revision' AND link.source_version='1' AND frame.workspace_id=w
    AND frame.id=link.source_id AND frame.session_id=message.session_id AND frame.format=2
    AND (SELECT count(*) FROM scope_derivation_sources original WHERE original.workspace_id=w AND original.derivation_id=d.id)=1
    AND native_turn_frame_pair(w,frame.id) IS TRUE
 ) s
 WHERE message.workspace_id=w AND message.id=resource.resource_id AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=resource.resource_id) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

    IF history_shape IS NOT TRUE THEN CONTINUE;END IF;
   END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=versions[wrapper_position];
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   -- The wrapper was captured by the canonical graph. Rebuilding it through
   -- the legacy session reader changes query membership for framed history.
   IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   memo:=conversation_dag(w,jsonb_build_array(jsonb_build_object('kind','application_field','id',resource.id,'version',versions[wrapper_position])),'[]');
   current_envelope:=memo#>ARRAY['field:'||resource.id||':'||versions[wrapper_position],'envelope'];
   IF current_envelope IS NULL OR current_envelope->>'resourceId' IS DISTINCT FROM resource.id::text
    OR current_envelope->>'identity' IS DISTINCT FROM resource.identity
    OR current_envelope#>>'{source,version}' IS DISTINCT FROM versions[wrapper_position]
    OR current_envelope#>>'{state,recordVersion}' IS DISTINCT FROM observation.record_version
    OR current_envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
    OR current_envelope#>>'{state,sourceKind}' IS DISTINCT FROM observation.source_kind
    OR current_envelope#>>'{state,sourceId}' IS DISTINCT FROM observation.source_id::text
    OR current_envelope#>>'{state,sourceVersion}' IS DISTINCT FROM observation.source_version
    OR ((current_envelope->'source')-ARRAY['resourceKind','resourceId','version']) IS DISTINCT FROM observation.source_scope
    THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_array(s.source_kind,s.source_id::text,s.source_version) ORDER BY s.source_kind,s.source_id::text,s.source_version),'[]') INTO observed_sources
    FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position];
   SELECT coalesce(jsonb_agg(jsonb_build_array(s->>'resourceKind',s->>'resourceId',s->>'version') ORDER BY s->>'resourceKind',s->>'resourceId',s->>'version'),'[]') INTO expected_sources
    FROM jsonb_array_elements(current_envelope->'sources') s;
   IF observed_sources IS DISTINCT FROM expected_sources THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   admitted:=memo#>ARRAY['field:'||resource.id||':'||versions[wrapper_position],'value'];
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[wrapper_position]
    OR (admitted-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM current_envelope->'source' THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   wrapper_source:=current_envelope->'source';delegated:='[]';
   IF resource.selection='query_domain' THEN
    SELECT * INTO frozen FROM application_query_domains q WHERE q.workspace_id=w AND q.id=resource.resource_id
     AND q.origin=resource.origin AND q.type_key=resource.type_key AND q.schema_version='1';
    IF NOT FOUND OR frozen.identity IS DISTINCT FROM observation.source_version OR observation.source_kind<>'application_query_domain'
     OR observation.source_id IS DISTINCT FROM frozen.id OR jsonb_array_length(current_envelope->'children')>4096 THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(current_envelope->'children') LOOP
     IF child->'origin' IS DISTINCT FROM resource.origin OR child->>'typeKey'<>'session_message'
      OR child->>'selection'<>'query' OR child->>'selectedVersion' IS NOT NULL
      OR child#>>'{state,sourceKind}'<>'session_message'
      OR NOT EXISTS(SELECT 1 FROM session_messages message WHERE message.workspace_id=w AND message.id=(child->>'id')::uuid
       AND message.id=(child#>>'{state,sourceId}')::uuid AND message.session_id=(frozen.domain->>'sessionId')::uuid
       AND message.sequence_num<=(frozen.domain->>'throughSequence')::integer)
      OR NOT EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position]
       AND s.source_kind='application_field' AND s.source_id=(child->>'resourceId')::uuid AND s.source_version=child#>>'{source,version}') THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,ARRAY['application_field'],ARRAY[(child->>'resourceId')::uuid],ARRAY[child#>>'{source,version}']) LOOP
      delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
      IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     END LOOP;
    END LOOP;
   ELSE
    IF observation.source_kind<>'session_message' OR observation.source_id IS DISTINCT FROM resource.resource_id
     OR observation.source_version<>'1' OR observation.record_version NOT LIKE '1:%' THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
     IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(delegated) s WHERE s#>>'{source,resourceKind}'='application_field'
      AND s#>>'{source,resourceId}'=direct_ids[direct_position]::text AND s->>'version'=direct_versions[direct_position]) THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
   END IF;
   wrapper_rows:=wrapper_rows||jsonb_build_object(wrapper_position::text,jsonb_build_array(jsonb_build_object('version',versions[wrapper_position],'source',wrapper_source))||delegated);
  END LOOP;
  IF wrapper_rows<>'{}'::jsonb THEN
   FOR wrapper_position IN 1..cardinality(ids) LOOP
    IF wrapper_rows ? wrapper_position::text THEN
     RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(wrapper_rows->wrapper_position::text);
    ELSE
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  SELECT origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key IN('session_message','session_message_annotation') INTO belongs
   FROM application_field_resources WHERE workspace_id=w AND id=(dependency.source->>'resourceId')::uuid;
  IF belongs IS DISTINCT FROM true THEN native_only:=false;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
 END LOOP;
 IF NOT native_only THEN RETURN QUERY SELECT * FROM read_admitted_application_field_dependencies(w,kinds,ids,versions);RETURN;END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 memo:=conversation_dag(w,coalesce((SELECT jsonb_agg(jsonb_build_object('kind','application_field','id',entry.node#>>'{source,resourceId}','version',entry.node->>'version')) FROM jsonb_array_elements(rows_json) entry(node)),'[]'::jsonb),'[]');
 FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
  admitted:=memo#>ARRAY['field:'||(item#>>'{source,resourceId}')||':'||(item->>'version'),'value'];
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(rows_json);
END $function$;

-- [COMP:api/native-turn-frame] Native adjacency, with explicit foreign-family delegation.
CREATE FUNCTION conversation_source_edges(w uuid,k text,i uuid,v text)
RETURNS TABLE(kind text,id uuid,version text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 IF k='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=i
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  RETURN QUERY SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i
  UNION SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v
  UNION SELECT o.source_kind,o.source_id,o.source_version FROM application_field_observation_sources o WHERE o.workspace_id=w AND o.resource_id=i AND o.version=v;
 ELSIF k IN('session_message','session_context_revision','application_query_domain','private_transcript') THEN
  -- These identities have no successor walk. Observation versions remain exact.
  RETURN QUERY SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE d.workspace_id=w AND d.resource_kind=k AND d.resource_id=i;
 ELSE
  -- Memory history qualification, file successors and foreign source families
  -- retain their owned semantics; they never grant native conversation admission.
  RETURN QUERY SELECT e.kind,e.id,e.version FROM application_scope_source_edges(w,k,i,v) e;
 END IF;
END $body$;
REVOKE ALL ON FUNCTION conversation_source_edges(uuid,text,uuid,text) FROM PUBLIC,app_user;

-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.conversation_prepare_publications(w uuid,s uuid,commands jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb;retained jsonb:='[]';dependency record;
 command jsonb;compiled jsonb:='[]';results jsonb:='[]';producer text;sources jsonb;target jsonb;
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;source_scope jsonb;projection jsonb;label jsonb;
 lineage jsonb;
 result jsonb;deadline timestamptz;privacy jsonb;seeds jsonb;frontier jsonb;edges jsonb:='[]';batch jsonb;
BEGIN

 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(commands) IS DISTINCT FROM 'array' OR jsonb_array_length(commands) NOT BETWEEN 1 AND 2
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR command IN SELECT value FROM jsonb_array_elements(commands) LOOP
  IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR command-ARRAY['producer','sources','target','purpose']<>'{}'
   OR command ? 'purpose' AND command->>'purpose' IS DISTINCT FROM 'session_title'
   OR NOT command ?& ARRAY['producer','sources','target'] OR jsonb_typeof(command->'producer') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  producer:=command->>'producer';sources:=command->'sources';target:=command->'target';expanded:=sources;
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
 THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(node->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(node->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(node->'version') IS DISTINCT FROM 'string' OR length(btrim(node->>'version')) NOT BETWEEN 1 AND 256
   OR node->>'resourceKind' NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 WITH RECURSIVE closure(kind,id,version,ordinary) AS (
  SELECT n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version',NOT EXISTS(
   SELECT 1 FROM application_field_resources f WHERE n->>'resourceKind'='application_field'
    AND f.workspace_id=w AND f.id=(n->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
  FROM jsonb_array_elements(sources) n
  UNION SELECT e.kind,e.id,e.version,c.ordinary FROM closure c
   CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ), bounded AS MATERIALIZED(SELECT * FROM closure LIMIT 8193), distinct_nodes AS(
  SELECT kind,id,version,bool_or(ordinary) ordinary FROM bounded GROUP BY kind,id,version
 ) SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO lineage FROM distinct_nodes n;
 IF jsonb_array_length(lineage)>4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(lineage) n
  WHERE n->>'kind' IS NULL OR n->>'id' IS NULL OR n->>'version' IS NULL
   OR n->>'kind'='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'))
 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 FOR dependency IN
  WITH history_roots AS MATERIALIZED(
   SELECT original.value FROM jsonb_array_elements(sources) original(value)
   JOIN application_field_resources f ON original.value->>'resourceKind'='application_field'
    AND f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'
  )
  SELECT DISTINCT node_version,source FROM (
   SELECT d.node_version,d.source FROM history_roots original
   CROSS JOIN LATERAL read_native_session_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   UNION ALL SELECT n->>'version',o.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',o.resource_id,'version',o.version)
    FROM jsonb_array_elements(lineage) n LEFT JOIN application_field_observations o
     ON o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
    WHERE n->>'kind'='application_field' AND n->>'ordinary'='true'
   UNION ALL SELECT n->>'version',CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
    'workspaceId',o.workspace_id,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',o.id,'version',o.version,
    'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids) END
    FROM jsonb_array_elements(lineage) n LEFT JOIN external_source_observations o ON o.workspace_id=w AND o.id=(n->>'id')::uuid
    WHERE n->>'kind'='external_source'
   UNION ALL SELECT n->>'version',read_scope_source(w,n->>'kind',(n->>'id')::uuid)
    FROM jsonb_array_elements(lineage) n WHERE n->>'kind'='session_context_revision'
  ) obligations
 LOOP
  node:=dependency.source;
  IF node IS NULL OR node->>'held'='true' OR node->>'version' IS DISTINCT FROM dependency.node_version
   OR entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  node:=jsonb_build_object('workspaceId',node->'workspaceId','userId',node->'userId','assistantId',node->'assistantId',
   'sensitivity',node->'sensitivity','compartments',node->'compartments','projectIds',node->'projectIds',
   'resourceKind',node->'resourceKind','resourceId',node->'resourceId','version',node->'version');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')
   AND (original->>'version' IS DISTINCT FROM node->>'version' OR (original-ARRAY['held','validTo','retractedAt','causalEntityId']) IS DISTINCT FROM node)) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')) THEN
   expanded:=expanded||jsonb_build_array(node);END IF;
  IF jsonb_array_length(expanded)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (candidate.value->>'resourceKind',candidate.value->>'resourceId')) FROM jsonb_array_elements(expanded) candidate(value))<>jsonb_array_length(expanded) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  compiled:=compiled||jsonb_build_array(command||jsonb_build_object('expanded',expanded));
 END LOOP;
 -- One physical acquisition owns both cohorts. Original descriptors and labels
 -- stay separate; sharing graph vertices never widens a cohort's lineage.
 memo:=conversation_dag(w,(SELECT jsonb_agg(root ORDER BY root::text) FROM (
  SELECT DISTINCT jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId','version',n->>'version') root
  FROM jsonb_array_elements(compiled) c CROSS JOIN LATERAL jsonb_array_elements(c->'expanded') n
 ) roots),'[]');
 FOR command IN SELECT value FROM jsonb_array_elements(compiled) LOOP
  producer:=command->>'producer';sources:=command->'sources';target:=command->'target';expanded:=command->'expanded';
  retained:='[]';edges:='[]';
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 -- The owning writer or independent completion operation authenticates the
 -- complete helper contract before entry and again before releasing its effect.
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   current_source:=memo#>ARRAY['field:'||(node->>'resourceId')||':'||(node->>'version'),'value'];
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE
   current_source:=NULLIF(memo#>ARRAY['current',(node->>'resourceKind')||':'||(node->>'resourceId')||':'||(node->>'version')],'null'::jsonb);
   IF memo#>>ARRAY['native:'||(node->>'resourceKind')||':'||(node->>'resourceId')||':'||(node->>'version'),'value'] IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF (command->>'purpose'='session_title' OR node->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript'))
   AND (current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version'
    OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
      IS DISTINCT FROM (node->'workspaceId',node->'userId',node->'assistantId',node->'sensitivity')
    OR NOT (current_source->'compartments')@>(node->'compartments') OR NOT (node->'compartments')@>(current_source->'compartments')
    OR NOT (current_source->'projectIds')@>(node->'projectIds') OR NOT (node->'projectIds')@>(current_source->'projectIds')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='crm_event' AND (current_source IS NULL OR current_source->>'version' IS DISTINCT FROM node->>'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) e WHERE e->>'resourceKind'='entity' AND e->>'resourceId'=current_source->>'causalEntityId')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) original WHERE
    (original->>'resourceKind',original->>'resourceId',original->>'version')=(node->>'resourceKind',node->>'resourceId',node->>'version'))
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(node->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(node->>'resourceId')::uuid],ARRAY[node->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt'])
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM target->>'userId'
      AND (target->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(node->>'resourceId')::uuid,node->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt']) THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF sensitivity_rank(node->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=node->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(node->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(node->'projectIds')::uuid)) value ORDER BY value);
  IF current_source IS NOT NULL AND current_source->>'validTo' IS NULL AND current_source->>'retractedAt' IS NULL THEN
   IF sensitivity_rank(current_source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=current_source->>'sensitivity';END IF;
   teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(current_source->'compartments'))) value ORDER BY value);
   projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(current_source->'projectIds')::uuid)) value ORDER BY value);
   IF current_source->>'version'=node->>'version' AND (current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS NOT DISTINCT FROM (node->'userId',node->'assistantId',node->'sensitivity') AND current_source->'compartments'=node->'compartments'
    AND current_source->'projectIds'=node->'projectIds' THEN retained:=retained||jsonb_build_array(node);END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) obligation(value)
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);

 result:=jsonb_build_object('scope',source_scope,'retained',retained)
  ||CASE WHEN command ? 'purpose' THEN jsonb_build_object('purpose',command->'purpose') ELSE '{}'::jsonb END;
 SELECT jsonb_agg(DISTINCT jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId')) INTO seeds
 FROM jsonb_array_elements(sources) n;
 frontier:=seeds;
 WHILE jsonb_array_length(frontier)>0 LOOP
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.parent::text,e.child::text),'[]') INTO batch
  FROM native_turn_privacy_edges(w,frontier) e;
  edges:=edges||batch;
  SELECT coalesce(jsonb_agg(DISTINCT e->'child'),'[]') INTO frontier FROM jsonb_array_elements(batch) e
  WHERE NOT seeds @> jsonb_build_array(e->'child');
  seeds:=seeds||frontier;
  IF jsonb_array_length(seeds)>4096 OR jsonb_array_length(edges)>65536 THEN
   RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 privacy:=jsonb_build_object('nodes',(SELECT jsonb_agg(n ORDER BY n::text) FROM jsonb_array_elements(seeds) n),
  'edges',(SELECT coalesce(jsonb_agg(e ORDER BY e::text),'[]') FROM jsonb_array_elements(edges) e));
 -- The independently fresh completion pass compares all-version adjacency,
 -- including ancestors added to an older observation during publication.
 result:=result||jsonb_build_object('privacy',privacy);
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM (
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT audience_deadlines.expires_at FROM (SELECT CASE WHEN pg_input_is_valid(binding->>'expiresAt','timestamp with time zone')
   THEN (binding->>'expiresAt')::timestamptz ELSE NULL END AS expires_at
  FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ci.config->'deliveryAudienceBindings')='array'
   THEN ci.config->'deliveryAudienceBindings' ELSE '[]'::jsonb END) binding
  WHERE c.workspace_id=w AND c.status='active' AND ci.status='active') audience_deadlines
  WHERE audience_deadlines.expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM external_source_authorizations
  WHERE workspace_id=w AND transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
   AND operation_id::text=nullif(current_setting('app.external_source_operation_id',true),'')
   AND observation_id IN(SELECT (n->>'resourceId')::uuid FROM jsonb_array_elements(result->'retained') n
    WHERE n->>'resourceKind'='external_source')
 UNION ALL SELECT to_timestamp((o.observation#>>'{retention,expiresAt}')::numeric/1000)
  FROM external_source_observations o JOIN jsonb_array_elements(result->'retained') n
   ON n->>'resourceKind'='external_source' AND o.workspace_id=w AND o.id=(n->>'resourceId')::uuid
  WHERE o.observation#>>'{retention,mode}'='released_snapshot') transitions;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
  results:=results||jsonb_build_array(result||jsonb_build_object('proof',jsonb_build_object('validUntil',deadline)));
 END LOOP;
 RETURN results;
END $body$;

REVOKE ALL ON FUNCTION conversation_prepare_publications(uuid,uuid,jsonb) FROM PUBLIC,app_user;

-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.native_turn_frame_payload_shape(p jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sources jsonb;n jsonb;kind text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['kind','originalSources','declaredSources']<>'{}'
  OR p->>'kind' NOT IN('native_turn_frame_v1','native_turn_frame_v2') OR p->>'kind' IS NULL THEN RETURN false;END IF;
 FOREACH sources IN ARRAY ARRAY[p->'originalSources',p->'declaredSources'] LOOP
  IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN (CASE WHEN p->>'kind'='native_turn_frame_v1' OR sources=p->'originalSources' THEN 1 ELSE 0 END) AND 4096
   OR (SELECT count(DISTINCT (v->>'resourceKind',v->>'resourceId')) FROM jsonb_array_elements(sources) v)<>jsonb_array_length(sources)
  THEN RETURN false;END IF;
  -- Resolve the source vocabulary once per distinct family, not once for
  -- every original/retained requirement in every earlier turn frame.
  FOR kind IN SELECT DISTINCT value->>'resourceKind' FROM jsonb_array_elements(sources) LOOP
   IF kind IS NULL OR (CASE WHEN p->>'kind'='native_turn_frame_v1'
    THEN kind NOT IN('session_message','session_context_revision','application_field','workspace_file')
    ELSE kind NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination')
     AND scope_source_table(kind) IS NULL END) THEN RETURN false;END IF;
  END LOOP;
  FOR n IN SELECT value FROM jsonb_array_elements(sources) LOOP
   IF n-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','resourceKind','resourceId','version']<>'{}'
    OR entity_derivation_envelope_valid(n) IS NOT TRUE OR NOT n ?& ARRAY['resourceKind','resourceId','version']
    OR jsonb_typeof(n->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'resourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(n->'version') IS DISTINCT FROM 'string' OR length(btrim(n->>'version')) NOT BETWEEN 1 AND 256
    OR (n->>'resourceId')::uuid IS NULL THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN p->>'kind'='native_turn_frame_v2' OR (p->'declaredSources') @> (p->'originalSources');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $function$;

-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.native_turn_frame_pair(w uuid, i uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE f native_turn_frames;r session_context_scope_revisions;d scope_derivations;parent sessions;p jsonb;edges jsonb;declared jsonb;
BEGIN
 SELECT * INTO f FROM native_turn_frames WHERE workspace_id=w AND id=i;
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 SELECT id,visibility,user_id INTO parent.id,parent.visibility,parent.user_id FROM sessions WHERE workspace_id=w AND id=r.session_id;
 SELECT content INTO p FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=i;
 IF f.id IS NULL OR r.id IS NULL OR parent.id IS NULL OR r.scope_held OR scope_review_state_held('session_context_revision',i)
  OR parent.visibility='personal' AND r.user_id IS DISTINCT FROM parent.user_id
  OR f.format=1 AND parent.visibility<>'personal' AND r.user_id IS NOT NULL
  OR r.assistant_id IS NOT NULL OR f.format NOT IN(1,2) OR (f.format=1) IS DISTINCT FROM (p->>'kind'='native_turn_frame_v1') OR r.parent_kind IS DISTINCT FROM 'turn_frame'
  OR r.parent_id IS DISTINCT FROM i OR r.session_id IS DISTINCT FROM f.session_id OR r.scope_version<>1
  OR native_turn_frame_payload_shape(p) IS NOT TRUE OR r.payload_sha256<>encode(sha256(convert_to(p::text,'UTF8')),'hex')
  OR f.manifest_digest<>r.payload_sha256 OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'originalSources')||(p->'declaredSources')) n
   WHERE n->>'workspaceId' IS DISTINCT FROM w::text OR n->>'resourceKind'='session_context_revision' AND n->>'resourceId'=i::text)
 THEN RETURN false;END IF;
 SELECT * INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_context_revision' AND resource_id=i AND resource_version='1';
 IF d.id IS NULL OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids)
  IS DISTINCT FROM (r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(source_kind,source_id,source_version) ORDER BY source_kind,source_id,source_version),'[]') INTO edges
 FROM scope_derivation_sources WHERE workspace_id=w AND derivation_id=d.id;
 SELECT coalesce(jsonb_agg(jsonb_build_array(n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version') ORDER BY n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version'),'[]')
 INTO declared FROM jsonb_array_elements(p->'declaredSources') n;
 IF edges IS DISTINCT FROM declared OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'originalSources')||(p->'declaredSources')) n
  WHERE n->>'userId' IS NOT NULL AND n->>'userId' IS DISTINCT FROM r.user_id::text
   OR sensitivity_rank(n->>'sensitivity')>sensitivity_rank(r.sensitivity)
   OR NOT to_jsonb(r.compartments) @> (n->'compartments') OR NOT to_jsonb(r.project_ids) @> (n->'projectIds')) THEN RETURN false;END IF;
 RETURN true;
END $function$;

-- [COMP:api/native-turn-frame] One publication owner for an annotation and transcript.
CREATE OR REPLACE FUNCTION public.publish_native_session_message_batch(w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;payload jsonb;node jsonb;
 envelope boolean:=jsonb_typeof(payloads)='object';annotation_command jsonb;session_row sessions;previous uuid;
 a_kind text:='message_annotation';a_parent uuid;a_id uuid;a_payload jsonb;a_producer text;a_sources jsonb;a_revision uuid;a_generation bigint;a_target jsonb;
 commands jsonb:='[]';prepared jsonb;a_prepared jsonb;t_prepared jsonb;
 a_frame uuid:=gen_random_uuid();t_frame uuid:=gen_random_uuid();leader uuid;compound boolean;
 a_frame_payload jsonb;t_frame_payload jsonb;a_scope jsonb;t_scope jsonb;a_retained jsonb;t_retained jsonb;
 a_tier text;t_tier text;a_teams text[];t_teams text[];a_projects uuid[];t_projects uuid[];
 next_sequence integer;results jsonb;annotation_result jsonb;
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF envelope THEN
  IF payloads-ARRAY['messages','annotation']<>'{}' OR NOT payloads ?& ARRAY['messages','annotation']
   OR jsonb_typeof(payloads->'annotation') IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  annotation_command:=payloads->'annotation';payloads:=payloads->'messages';
  IF annotation_command-ARRAY['kind','parentId','id','content','producer','sources','expectedRevision','expectedGeneration']<>'{}'
   OR NOT annotation_command ?& ARRAY['parentId','id','content','producer','sources','expectedRevision','expectedGeneration']
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF annotation_command ? 'kind' THEN a_kind:=annotation_command->>'kind';END IF;
  IF a_kind IS NULL OR a_kind NOT IN('message_annotation','session_title')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  a_parent:=(annotation_command->>'parentId')::uuid;a_id:=(annotation_command->>'id')::uuid;
  a_payload:=annotation_command->'content';a_producer:=annotation_command->>'producer';a_sources:=annotation_command->'sources';
  a_revision:=(annotation_command->>'expectedRevision')::uuid;a_generation:=(annotation_command->>'expectedGeneration')::bigint;
 END IF;
 IF jsonb_typeof(payloads) IS DISTINCT FROM 'array' OR jsonb_array_length(payloads)>512
  OR jsonb_array_length(payloads)=0 AND annotation_command IS NULL
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF annotation_command IS NOT NULL THEN
 IF a_parent IS NULL OR a_id IS NULL OR session_context_payload_shape(a_kind,a_payload) IS NOT TRUE
  OR length(btrim(a_producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(a_sources) IS DISTINCT FROM 'array' OR jsonb_array_length(a_sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT(n->>'resourceKind',n->>'resourceId')) FROM jsonb_array_elements(a_sources) n)<>jsonb_array_length(a_sources)
  OR a_kind='session_title' AND jsonb_array_length(payloads)<>0
  OR a_kind='message_annotation' AND (NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND id=a_parent)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a_sources) n WHERE n->>'resourceKind'='session_message' AND n->>'resourceId'=a_parent::text))
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT session_row FROM sessions WHERE workspace_id=w AND id=s;
 IF a_kind='session_title' THEN
  IF a_parent<>s OR (a_payload->>'manual')::boolean IS FALSE AND session_row.title_manually_set THEN
   RETURN jsonb_build_object('messages','[]'::jsonb,'annotation',NULL);END IF;
  SELECT scope_revision_id INTO previous FROM session_title_heads WHERE workspace_id=w AND session_id=s;
 ELSE
  SELECT scope_revision_id INTO previous FROM session_message_annotation_heads WHERE workspace_id=w AND session_id=s AND message_id=a_parent;
 END IF;
 IF a_generation IS NOT NULL AND session_row.session_context_generation<>a_generation OR previous IS DISTINCT FROM a_revision
 THEN RETURN jsonb_build_object('messages','[]'::jsonb,'annotation',NULL);END IF;
 SELECT jsonb_agg(jsonb_build_object('workspaceId',n->'workspaceId','userId',n->'userId','assistantId',n->'assistantId',
  'sensitivity',n->'sensitivity','compartments',n->'compartments','projectIds',n->'projectIds',
  'resourceKind',n->'resourceKind','resourceId',n->'resourceId','version',n->'version') ORDER BY ordinal)
 INTO a_sources FROM jsonb_array_elements(a_sources) WITH ORDINALITY original(n,ordinal);

  a_target:=jsonb_build_object('workspaceId',w,'userId',parent->'userId','assistantId',NULL,'sensitivity',parent->'sensitivity','compartments',parent->'compartments','projectIds',parent->'projectIds');
  commands:=commands||jsonb_build_array(jsonb_build_object('producer',a_producer,'sources',a_sources,'target',a_target)
   ||CASE WHEN a_kind='session_title' THEN jsonb_build_object('purpose',a_kind) ELSE '{}'::jsonb END);
 END IF;
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']
  OR payload-ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']<>'{}'
  OR payload->>'role' NOT IN('user','assistant') OR jsonb_typeof(payload->'role') IS DISTINCT FROM 'string'
  OR jsonb_typeof(payload->'attachments') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'attachments')>100
  OR jsonb_typeof(payload->'channelMessageId') NOT IN('null','string')
  OR jsonb_typeof(payload->'senderUserId') NOT IN('null','string') OR jsonb_typeof(payload->'senderAssistantId') NOT IN('null','string')
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
  OR payload->>'senderUserId' IS NOT NULL AND payload->>'senderUserId' IS DISTINCT FROM actor::text
  OR payload->>'senderAssistantId' IS NOT NULL AND (payload->>'role'<>'assistant'
   OR payload->>'senderAssistantId' IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF jsonb_array_length(payloads)>0 THEN
 SELECT jsonb_agg(jsonb_build_object('workspaceId',n->'workspaceId','userId',n->'userId','assistantId',n->'assistantId',
  'sensitivity',n->'sensitivity','compartments',n->'compartments','projectIds',n->'projectIds',
  'resourceKind',n->'resourceKind','resourceId',n->'resourceId','version',n->'version') ORDER BY ordinal)
 INTO sources FROM jsonb_array_elements(sources) WITH ORDINALITY original(n,ordinal);
 commands:=commands||jsonb_build_array(jsonb_build_object('producer',producer,'sources',sources,'target',target));
 END IF;
 prepared:=conversation_prepare_publications(w,s,commands);
 IF prepared IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF annotation_command IS NOT NULL THEN
  a_prepared:=prepared->0;a_scope:=a_prepared->'scope';a_retained:=a_prepared->'retained';a_tier:=a_scope->>'sensitivity';
  a_teams:=ARRAY(SELECT jsonb_array_elements_text(a_scope->'compartments'));a_projects:=ARRAY(SELECT jsonb_array_elements_text(a_scope->'projectIds')::uuid);
  a_frame_payload:=jsonb_build_object('kind','native_turn_frame_v2','originalSources',a_sources,'declaredSources',a_retained);
 END IF;
 IF jsonb_array_length(payloads)>0 THEN
  t_prepared:=prepared->(jsonb_array_length(prepared)-1);t_scope:=t_prepared->'scope';t_retained:=t_prepared->'retained';t_tier:=t_scope->>'sensitivity';
  t_teams:=ARRAY(SELECT jsonb_array_elements_text(t_scope->'compartments'));t_projects:=ARRAY(SELECT jsonb_array_elements_text(t_scope->'projectIds')::uuid);
  t_frame_payload:=jsonb_build_object('kind','native_turn_frame_v2','originalSources',sources,'declaredSources',t_retained);
 END IF;
 FOR payload IN SELECT value FROM jsonb_array_elements(payloads) LOOP
 FOR node IN SELECT value FROM jsonb_array_elements(payload->'attachments') LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t_retained) input WHERE input->>'resourceKind'='workspace_file' AND input->>'resourceId'=node->>'fileId') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 END LOOP;

 compound:=annotation_command IS NOT NULL AND jsonb_array_length(payloads)>0;
 leader:=CASE WHEN jsonb_array_length(payloads)>0 THEN t_frame ELSE a_frame END;
 INSERT INTO native_turn_publication_work(transaction_id,workspace_id,frame_id,session_id,context,original_sources,prepared,completion_owner)
 SELECT txid_current(),w,a_frame,s,native_turn_context(),a_sources,a_prepared-'proof',CASE WHEN compound THEN leader END WHERE annotation_command IS NOT NULL
 UNION ALL SELECT txid_current(),w,t_frame,s,native_turn_context(),sources,t_prepared-'proof',CASE WHEN compound THEN leader END WHERE jsonb_array_length(payloads)>0;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 SELECT coalesce(max(sequence_num),0) INTO next_sequence FROM session_messages WHERE session_id=s;
 WITH a_frame_revision AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT a_frame,w,s,'turn_frame',a_frame,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,encode(sha256(convert_to(a_frame_payload::text,'UTF8')),'hex') WHERE annotation_command IS NOT NULL RETURNING id
 ), a_frame_record AS (
  INSERT INTO native_turn_frames(workspace_id,id,session_id,format,manifest_digest)
  SELECT id_workspace,id_frame,s,2,encode(sha256(convert_to(a_frame_payload::text,'UTF8')),'hex') FROM (SELECT w id_workspace,id id_frame FROM a_frame_revision) ready RETURNING id
 ), a_frame_contents AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content)
  SELECT w,id,a_frame_payload FROM a_frame_record RETURNING revision_id
 ), a_frame_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',a_frame,'1',a_producer,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM a_frame_contents) ready WHERE workspace_id=w AND annotation_command IS NOT NULL RETURNING id
 ), a_frame_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,d.id,n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version' FROM a_frame_declaration d CROSS JOIN jsonb_array_elements(a_retained) n
  ORDER BY n->>'resourceKind',n->>'resourceId' RETURNING derivation_id
 ), a_annotation AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT a_id,w,s,a_kind,a_parent,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,encode(sha256(convert_to(a_payload::text,'UTF8')),'hex')
  FROM(SELECT count(*) FROM a_frame_edges) ready WHERE annotation_command IS NOT NULL RETURNING id,created_at
 ), a_annotation_content AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) SELECT w,id,a_payload FROM a_annotation RETURNING revision_id
 ), a_head AS (
  INSERT INTO session_message_annotation_heads(message_id,workspace_id,session_id,scope_revision_id)
  SELECT a_parent,w,s,revision_id FROM a_annotation_content WHERE a_kind='message_annotation' ON CONFLICT(message_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id RETURNING message_id
 ), a_title_head AS (
  INSERT INTO session_title_heads(workspace_id,session_id,scope_revision_id)
  SELECT w,s,revision_id FROM a_annotation_content WHERE a_kind='session_title'
  ON CONFLICT(session_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id RETURNING session_id
 ), a_generation AS (
  UPDATE sessions SET session_context_generation=session_context_generation+1,
   title=CASE WHEN a_kind='session_title' THEN NULL ELSE title END,
   title_manually_set=CASE WHEN a_kind='session_title' THEN (a_payload->>'manual')::boolean ELSE title_manually_set END
  FROM(SELECT count(*) FROM a_head) ready CROSS JOIN(SELECT count(*) FROM a_title_head) title_ready
  WHERE workspace_id=w AND id=s AND annotation_command IS NOT NULL RETURNING id
 ), a_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',a_id,'1',a_producer,(a_scope->>'userId')::uuid,NULL,a_tier,a_teams,a_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM a_generation) ready WHERE workspace_id=w AND annotation_command IS NOT NULL RETURNING id
 ), a_annotation_edge AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,id,'session_context_revision',a_frame,'1' FROM a_declaration RETURNING derivation_id
 ), t_frame_revision AS (
  INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  SELECT t_frame,w,s,'turn_frame',t_frame,(t_scope->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,encode(sha256(convert_to(t_frame_payload::text,'UTF8')),'hex') WHERE jsonb_array_length(payloads)>0 RETURNING id
 ), t_frame_record AS (
  INSERT INTO native_turn_frames(workspace_id,id,session_id,format,manifest_digest)
  SELECT w,id,s,2,encode(sha256(convert_to(t_frame_payload::text,'UTF8')),'hex') FROM t_frame_revision RETURNING id
 ), t_frame_contents AS (
  INSERT INTO session_context_revision_contents(workspace_id,revision_id,content)
  SELECT w,id,t_frame_payload FROM t_frame_record RETURNING revision_id
 ), t_frame_declaration AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',t_frame,'1',producer,(t_scope->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,revision
  FROM workspace_access_policies CROSS JOIN(SELECT count(*) FROM t_frame_contents) ready WHERE workspace_id=w AND jsonb_array_length(payloads)>0 RETURNING id
 ), t_frame_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,d.id,n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version' FROM t_frame_declaration d CROSS JOIN jsonb_array_elements(t_retained) n
  ORDER BY n->>'resourceKind',n->>'resourceId' RETURNING derivation_id
 ), t_written AS (
  INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,sender_assistant_id,attachments,
   workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
  SELECT s,n.value->>'role',n.value->'content',next_sequence+n.ordinality,n.value->>'channelMessageId',
   (n.value->>'senderUserId')::uuid,(n.value->>'senderAssistantId')::uuid,n.value->'attachments',w,(target->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,1,false
  FROM jsonb_array_elements(payloads) WITH ORDINALITY n(value,ordinality) CROSS JOIN(SELECT count(*) FROM t_frame_edges) ready
  ORDER BY n.ordinality RETURNING *
 ), t_declarations AS (
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_message',m.id,'1',producer,(target->>'userId')::uuid,NULL,t_tier,t_teams,t_projects,p.revision
  FROM t_written m CROSS JOIN workspace_access_policies p WHERE p.workspace_id=w RETURNING id,resource_id
 ), t_message_edges AS (
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,id,'session_context_revision',t_frame,'1' FROM t_declarations RETURNING derivation_id
 ), output_rows AS (
  SELECT a_frame frame_id,jsonb_build_object('kind',a_kind,'id',a_id,'parentId',a_parent,'derivationId',d.id,
   'payloadDigest',encode(sha256(convert_to(a_payload::text,'UTF8')),'hex')) value
  FROM a_declaration d CROSS JOIN(SELECT count(*) FROM a_annotation_edge) ready
  UNION ALL SELECT t_frame,jsonb_build_object('id',m.id,'derivationId',d.id,'sequence',m.sequence_num,
   'payloadDigest',encode(sha256(convert_to(jsonb_build_object('role',m.role,'content',m.content,'channelMessageId',m.channel_message_id,
    'senderUserId',m.sender_user_id,'senderAssistantId',m.sender_assistant_id,'attachments',m.attachments)::text,'UTF8')),'hex'))
  FROM t_written m JOIN t_declarations d ON d.resource_id=m.id CROSS JOIN(SELECT count(*) FROM t_message_edges) ready
 ), seal AS (
  INSERT INTO native_turn_publication_seals(transaction_id,frame_id,outputs)
  SELECT txid_current(),leader,jsonb_agg(value||CASE WHEN compound THEN jsonb_build_object('frameId',frame_id) ELSE '{}'::jsonb END ORDER BY frame_id,value::text) FROM output_rows
  RETURNING native_turn_publication_seals.transaction_id,native_turn_publication_seals.frame_id
 ), debt AS (
  INSERT INTO native_turn_publication_debt SELECT seal.transaction_id,o.frame_id FROM seal CROSS JOIN(SELECT DISTINCT frame_id FROM output_rows) o
  RETURNING native_turn_publication_debt.frame_id
 ) SELECT
  (SELECT coalesce(jsonb_agg(jsonb_build_object('message',jsonb_build_object('id',m.id,'sessionId',s,'role',m.role,'content',m.content,
   'sequenceNum',m.sequence_num,'createdAt',m.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
   'channelMessageId',m.channel_message_id,'senderUserId',m.sender_user_id,'senderAssistantId',m.sender_assistant_id,'attachments',m.attachments),
   'source',t_scope||jsonb_build_object('resourceKind','session_message','resourceId',m.id,'version','1')) ORDER BY m.sequence_num),'[]') FROM t_written m),
  (SELECT jsonb_build_object('source',a_scope||jsonb_build_object('resourceKind','session_context_revision','resourceId',a_id,'version','1'),
   'createdAt',a.created_at,'userId',session_row.user_id,'assistantId',session_row.assistant_id) FROM a_annotation a)
 INTO results,annotation_result FROM(SELECT count(*) FROM debt) ready;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN CASE WHEN envelope THEN jsonb_build_object('messages',results,'annotation',annotation_result) ELSE results END;
EXCEPTION WHEN SQLSTATE 'PNT02' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
END $function$;

-- [COMP:api/native-turn-frame] Fresh completion belongs to the whole physical publication.
CREATE OR REPLACE FUNCTION public.native_turn_complete_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $function$
DECLARE work native_turn_publication_work;leader native_turn_publication_work;fresh jsonb;item jsonb;message session_messages;d scope_derivations;
 expected_scope jsonb;actual_scope jsonb;actual_payload jsonb;events jsonb;actual_events jsonb;frame_content jsonb;frame_scope jsonb;annotation session_context_scope_revisions;
 members uuid[];cohort_outputs jsonb;commands jsonb;proofs jsonb;ordinal integer:=0;
BEGIN
 SELECT * INTO leader FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=NEW.frame_id;
 IF leader.frame_id IS NULL OR NEW.transaction_id<>txid_current() OR native_turn_helpers_current() IS NOT TRUE
  OR native_turn_context() IS DISTINCT FROM leader.context OR leader.completion_owner IS NOT NULL AND leader.completion_owner<>leader.frame_id
  OR jsonb_typeof(NEW.outputs) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT array_agg(frame_id ORDER BY frame_id),jsonb_agg(jsonb_build_object('producer','native:turn-frame','sources',original_sources,'target',prepared->'scope')
  ||CASE WHEN prepared ? 'purpose' THEN jsonb_build_object('purpose',prepared->'purpose') ELSE '{}'::jsonb END ORDER BY frame_id)
 INTO members,commands FROM native_turn_publication_work
 WHERE transaction_id=txid_current() AND (leader.completion_owner IS NULL AND frame_id=leader.frame_id OR completion_owner=leader.frame_id);
 IF leader.completion_owner IS NULL THEN
  IF cardinality(members)<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outputs) n WHERE n ? 'frameId')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 ELSE
  IF cardinality(members)<>2 OR jsonb_array_length(NEW.outputs) NOT BETWEEN 2 AND 513
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outputs) n WHERE NOT n ? 'frameId' OR NOT (n->>'frameId')::uuid=ANY(members))
   OR (SELECT count(*) FROM jsonb_array_elements(NEW.outputs) n WHERE n->>'kind'='message_annotation')<>1
   OR EXISTS(SELECT 1 FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=ANY(members) AND frame_id<>leader.frame_id)
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END IF;
 -- The independent completion command observes every payload/head mutation.
 proofs:=conversation_prepare_publications(leader.workspace_id,leader.session_id,commands);
 FOR work IN SELECT * FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=ANY(members) ORDER BY frame_id LOOP
  IF (work.workspace_id,work.session_id,work.context,work.completion_owner) IS DISTINCT FROM
   (leader.workspace_id,leader.session_id,leader.context,leader.completion_owner)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(n) INTO cohort_outputs FROM jsonb_array_elements(NEW.outputs) n
   WHERE leader.completion_owner IS NULL OR n->>'frameId'=work.frame_id::text;
  IF leader.completion_owner IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(cohort_outputs) n WHERE n ? 'kind')
   AND (jsonb_array_length(cohort_outputs)<>1 OR cohort_outputs->0->>'kind' IS DISTINCT FROM 'message_annotation')
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF work.frame_id IS NULL OR NEW.transaction_id<>txid_current()
  OR native_turn_context() IS DISTINCT FROM work.context OR native_turn_frame_pair(work.workspace_id,work.frame_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM native_turn_publication_debt WHERE transaction_id=txid_current() AND frame_id=work.frame_id)
  OR EXISTS(SELECT 1 FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=work.frame_id AND NOT fired)
  OR jsonb_typeof(cohort_outputs) IS DISTINCT FROM 'array' OR jsonb_array_length(cohort_outputs) NOT BETWEEN 1 AND 512
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 expected_scope:=work.prepared->'scope';
 SELECT c.content,jsonb_build_object('workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,
  'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids)
 INTO frame_content,frame_scope FROM session_context_scope_revisions r JOIN session_context_revision_contents c
 ON c.workspace_id=r.workspace_id AND c.revision_id=r.id WHERE r.workspace_id=work.workspace_id AND r.id=work.frame_id;
 IF frame_content->'originalSources' IS DISTINCT FROM work.original_sources
  OR frame_content->'declaredSources' IS DISTINCT FROM work.prepared->'retained' OR frame_scope IS DISTINCT FROM expected_scope
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(cohort_outputs) LOOP
  IF item->>'kind' IN('message_annotation','session_title') THEN
   SELECT * INTO annotation FROM session_context_scope_revisions WHERE workspace_id=work.workspace_id AND session_id=work.session_id AND id=(item->>'id')::uuid;
   SELECT * INTO d FROM scope_derivations WHERE workspace_id=work.workspace_id AND id=(item->>'derivationId')::uuid;
   SELECT c.content INTO actual_payload FROM session_context_revision_contents c WHERE c.workspace_id=work.workspace_id AND c.revision_id=annotation.id;
   actual_scope:=jsonb_build_object('workspaceId',annotation.workspace_id,'userId',annotation.user_id,'assistantId',annotation.assistant_id,
    'sensitivity',annotation.sensitivity,'compartments',annotation.compartments,'projectIds',annotation.project_ids);
   IF annotation.id IS NULL OR annotation.parent_kind IS DISTINCT FROM item->>'kind' OR annotation.parent_id::text IS DISTINCT FROM item->>'parentId'
    OR annotation.scope_version<>1 OR annotation.scope_held OR scope_review_state_held('session_context_revision',annotation.id)
    OR actual_scope IS DISTINCT FROM expected_scope OR actual_payload IS NULL OR session_context_payload_shape(item->>'kind',actual_payload) IS NOT TRUE
    OR annotation.payload_sha256 IS DISTINCT FROM item->>'payloadDigest' OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(actual_payload::text,'UTF8')),'hex')
    OR item->>'kind'='message_annotation' AND (NOT EXISTS(SELECT 1 FROM session_messages m JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
     WHERE m.workspace_id=work.workspace_id AND m.session_id=work.session_id AND m.id=annotation.parent_id AND h.scope_revision_id=annotation.id)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(work.original_sources) n WHERE n->>'resourceKind'='session_message' AND n->>'resourceId'=annotation.parent_id::text))
    OR item->>'kind'='session_title' AND (work.prepared->>'purpose' IS DISTINCT FROM 'session_title'
     OR annotation.parent_id IS DISTINCT FROM work.session_id
     OR NOT EXISTS(SELECT 1 FROM session_title_heads h JOIN sessions s ON s.workspace_id=h.workspace_id AND s.id=h.session_id
      WHERE h.workspace_id=work.workspace_id AND h.session_id=work.session_id AND h.scope_revision_id=annotation.id
       AND s.title IS NULL AND s.title_manually_set IS NOT DISTINCT FROM (actual_payload->>'manual')::boolean))
    OR d.id IS NULL OR d.resource_kind IS DISTINCT FROM 'session_context_revision' OR d.resource_id IS DISTINCT FROM annotation.id OR d.resource_version IS DISTINCT FROM '1'
    OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids) IS DISTINCT FROM
      (annotation.user_id,annotation.assistant_id,annotation.sensitivity,annotation.compartments,annotation.project_ids)
    OR (SELECT count(*) FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id)<>1
    OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id AND source_kind='session_context_revision' AND source_id=work.frame_id AND source_version='1')
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   CONTINUE;
  END IF;
  IF item ? 'kind' THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT * INTO message FROM session_messages WHERE workspace_id=work.workspace_id AND session_id=work.session_id AND id=(item->>'id')::uuid;
  SELECT * INTO d FROM scope_derivations WHERE workspace_id=work.workspace_id AND id=(item->>'derivationId')::uuid;
  actual_scope:=jsonb_build_object('workspaceId',message.workspace_id,'userId',message.user_id,'assistantId',message.assistant_id,
   'sensitivity',message.sensitivity,'compartments',message.compartments,'projectIds',message.project_ids);
  actual_payload:=jsonb_build_object('role',message.role,'content',message.content,'channelMessageId',message.channel_message_id,
   'senderUserId',message.sender_user_id,'senderAssistantId',message.sender_assistant_id,'attachments',message.attachments);
  IF message.id IS NULL OR message.scope_held OR scope_review_state_held('session_message',message.id) OR message.scope_version<>1 OR message.sequence_num IS DISTINCT FROM (item->>'sequence')::integer
   OR actual_scope IS DISTINCT FROM expected_scope OR item->>'payloadDigest' IS DISTINCT FROM encode(sha256(convert_to(actual_payload::text,'UTF8')),'hex')
   OR d.id IS NULL OR d.resource_kind IS DISTINCT FROM 'session_message' OR d.resource_id IS DISTINCT FROM message.id OR d.resource_version IS DISTINCT FROM '1'
   OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids) IS DISTINCT FROM
      (message.user_id,message.assistant_id,message.sensitivity,message.compartments,message.project_ids)
   OR (SELECT count(*) FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id)<>1
   OR NOT EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=work.workspace_id AND derivation_id=d.id
    AND source_kind='session_context_revision' AND source_id=work.frame_id AND source_version='1') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 SELECT jsonb_agg(event ORDER BY event::text) INTO events FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=work.frame_id;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text) INTO actual_events FROM scope_derivation_sources e JOIN scope_derivations actual_derivation ON actual_derivation.workspace_id=e.workspace_id AND actual_derivation.id=e.derivation_id
 WHERE actual_derivation.workspace_id=work.workspace_id AND (actual_derivation.resource_kind='session_context_revision' AND actual_derivation.resource_id=work.frame_id
  OR actual_derivation.id IN(SELECT (n->>'derivationId')::uuid FROM jsonb_array_elements(cohort_outputs) n));
 IF events IS NULL OR events IS DISTINCT FROM actual_events THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;

  fresh:=proofs->ordinal;ordinal:=ordinal+1;
  IF fresh IS NULL OR (fresh-'proof') IS DISTINCT FROM work.prepared OR native_turn_context() IS DISTINCT FROM work.context
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF fresh#>>'{proof,validUntil}' IS NULL OR clock_timestamp()>=(fresh#>>'{proof,validUntil}')::timestamptz
  THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 END LOOP;
 IF ordinal<>cardinality(members) OR native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 UPDATE native_turn_publication_work SET completion_ready=true WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_debt WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_events WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 DELETE FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=leader.frame_id;
 DELETE FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id=ANY(members);
 RETURN NULL;
END $function$;

-- [COMP:api/native-turn-frame] Annotation and title dispatch share canonical publication.
CREATE OR REPLACE FUNCTION public.publish_native_session_context_revision(w uuid, s uuid, k text, p uuid, i uuid, payload jsonb, producer text, sources jsonb, expected_revision uuid, expected_generation bigint, expected_cursor integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE framed jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';
BEGIN
 IF k IN('message_annotation','session_title') THEN
  framed:=publish_native_session_message_batch(w,s,jsonb_build_object('messages','[]'::jsonb,'annotation',jsonb_build_object(
   'kind',k,'parentId',p,'id',i,'content',payload,'producer',producer,'sources',sources,'expectedRevision',expected_revision,'expectedGeneration',expected_generation)),producer,sources,NULL);
  RETURN NULLIF(framed->'annotation','null'::jsonb);
 END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF k NOT IN('session_state','episodic_memory','compact_summary') OR p IS NULL OR i IS NULL
  OR session_context_payload_shape(k,payload) IS NOT TRUE OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT (node->>'resourceKind',node->>'resourceId')) FROM jsonb_array_elements(sources) node)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT target FROM sessions WHERE workspace_id=w AND id=s;
 IF expected_generation IS NOT NULL AND target.session_context_generation<>expected_generation THEN RETURN NULL;END IF;
 IF k='compact_summary' THEN
  IF p<>s OR target.compact_boundary_sequence IS DISTINCT FROM expected_cursor THEN RETURN NULL;END IF;
 ELSIF k='session_state' THEN
  SELECT scope_revision_id INTO previous FROM session_state WHERE id=p AND session_id=s;
  IF FOUND THEN IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
  ELSIF expected_revision IS NOT NULL OR expected_generation IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF expected_revision IS NOT NULL OR EXISTS(SELECT 1 FROM episodic_memories WHERE id=p) THEN RETURN NULL;END IF;
 END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 memo:=conversation_dag(w,(SELECT jsonb_agg(jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId','version',n->>'version')) FROM jsonb_array_elements(sources) n),'[]');
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   current_source:=memo#>ARRAY['field:'||(source->>'resourceId')||':'||(source->>'version'),'value'];
  ELSIF source->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(source->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current_source->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;

 INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  VALUES(i,w,s,k,p,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,encode(sha256(convert_to(payload::text,'UTF8')),'hex')) RETURNING created_at INTO created;
 INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) VALUES(w,i,payload);
 IF k='session_state' THEN
  INSERT INTO session_state(id,session_id,user_id,assistant_id,key,status,summary,detail,source,scope_revision_id)
   VALUES(p,s,target.user_id,target.assistant_id,p::text,'open','',NULL,'tool',i)
   ON CONFLICT(id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id,updated_at=now();
 ELSIF k='episodic_memory' THEN
  INSERT INTO episodic_memories(id,user_id,assistant_id,session_id,topic_label,summary,message_span,scope_revision_id)
   VALUES(p,target.user_id,target.assistant_id,s,'','','{}',i);
 ELSE
  UPDATE sessions SET compact_summary=NULL,compact_scope_revision_id=i,compact_boundary_sequence=(payload->>'boundarySequence')::integer,
   compaction_count=compaction_count+1,last_compacted_at=now() WHERE workspace_id=w AND id=s;
 END IF;
 UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE workspace_id=w AND id=s;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',i,'1',producer,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,node->>'resourceKind',(node->>'resourceId')::uuid,node->>'version' FROM jsonb_array_elements(sources) node ORDER BY node->>'resourceKind',node->>'resourceId';
 IF (SELECT encode(sha256(convert_to(to_jsonb(guard_proc)::text,'UTF8')),'hex') FROM pg_proc guard_proc WHERE guard_proc.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $function$
;

-- [COMP:api/native-turn-frame] Explicit current recording-epoch admission.
-- This owns the channel/member/route fences formerly hidden in reader eligibility.
-- A false result is not historical erasure or source admission.
CREATE FUNCTION conversation_recording_scope(w uuid,session_ids jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE epochs jsonb;initial jsonb;pass integer;
BEGIN
 FOR pass IN 1..2 LOOP
 WITH parent_ids AS(SELECT value::uuid id FROM jsonb_array_elements_text(session_ids)), certificates AS(
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
 ) SELECT coalesce(jsonb_object_agg(id::text,certificate),'{}'::jsonb) INTO epochs FROM certificates;

 IF EXISTS(SELECT 1 FROM jsonb_each(epochs) entry WHERE entry.value->>'eligible' IS DISTINCT FROM 'true') THEN RETURN false;END IF;
 IF pass=1 THEN
  initial:=epochs;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id IN(
  SELECT (p#>>'{owner,userId}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience#>>'{approver,userId}')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY user_id FOR SHARE NOWAIT;
 -- A channel key lock also fences a new route inserted through its FK.
 PERFORM id FROM channels WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{channel,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'channelId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM channel_integrations WHERE id IN(
  SELECT (p#>>'{integration,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'integrationId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_assistants WHERE channel_id IN(
  SELECT (p#>>'{channel,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_recording_policies WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{policy,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
 ) ORDER BY id FOR SHARE NOWAIT;

 ELSE
  IF epochs IS DISTINCT FROM initial THEN RETURN false;END IF;
 END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN lock_not_available OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION conversation_recording_scope(uuid,jsonb) FROM PUBLIC,app_user;

-- [COMP:api/native-turn-frame] Complete all-version recording ancestry before payload.
-- This operation-local result is never durable permission or reusable admission.
CREATE FUNCTION conversation_capture_privacy(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE result jsonb;node_count integer;session_ids jsonb;archive_denied jsonb;archive_count integer;
BEGIN
 WITH RECURSIVE points AS MATERIALIZED(
  SELECT n->>'kind' kind,(n->>'id')::uuid id,application_field_resource_uuid(application_field_digest(jsonb_build_object(
   'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',n->>'kind','id',n->>'id',
   'selection','query','selectedVersion',NULL,'fields',n->'fields','fieldIdentity',application_field_digest(jsonb_build_object(
    'kind','session_field_v1','type',n->>'kind','fields',n->'fields'))))) field_id
  FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='point'
 ), edges(parent_kind,parent_id,child_kind,child_id) AS NOT MATERIALIZED(
  SELECT d.resource_kind,d.resource_id,s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observations o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observation_sources o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',f.id,'session_message',f.resource_id FROM application_field_resources f
   WHERE f.workspace_id=w AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key IN('session_message','session_message_annotation')
  UNION ALL SELECT 'application_field',p.field_id,'session_message',p.id FROM points p
  UNION ALL SELECT 'application_field',p.field_id,'session_context_revision',h.scope_revision_id FROM points p
   JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.message_id=p.id WHERE p.kind='session_message_annotation'
 ), closure(kind,id) AS(
  SELECT n->>'kind',(n->>'id')::uuid FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='source'
  UNION SELECT 'application_field',field_id FROM points
  UNION SELECT e.child_kind,e.child_id FROM closure c JOIN edges e ON e.parent_kind=c.kind AND e.parent_id=c.id
 ), reached AS MATERIALIZED(SELECT * FROM closure LIMIT 4097), parents(kind,id,session_id) AS MATERIALIZED(
  SELECT n.kind,n.id,s.id FROM reached n JOIN sessions s ON n.kind='session' AND s.id=n.id AND s.workspace_id=w
  UNION SELECT n.kind,n.id,m.session_id FROM reached n JOIN session_messages m ON n.kind='session_message' AND m.id=n.id
   JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=w
  UNION SELECT n.kind,n.id,r.session_id FROM reached n JOIN session_context_scope_revisions r ON n.kind='session_context_revision' AND r.id=n.id AND r.workspace_id=w
  UNION SELECT n.kind,n.id,s.session_id FROM reached n JOIN session_state s ON n.kind='session_state' AND s.id=n.id
  UNION SELECT n.kind,n.id,e.session_id FROM reached n JOIN episodic_memories e ON n.kind='episodic_memory' AND e.id=n.id
  UNION SELECT n.kind,n.id,e.session_id FROM reached n JOIN analytics_events e ON n.kind='feedback_event' AND e.id=n.id
 ), checked AS MATERIALIZED(
  SELECT session_id,session_recording_read_allowed(session_id) allowed FROM(SELECT DISTINCT session_id FROM parents WHERE session_id IS NOT NULL) p
 ), denied(kind,id) AS(
  SELECT p.kind,p.id FROM parents p JOIN checked c USING(session_id) WHERE NOT c.allowed
  UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN edges e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}'),(SELECT coalesce(jsonb_agg(session_id),'[]') FROM checked) INTO node_count,result,session_ids FROM denied;
 IF node_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Archive ancestry is causal, unlike recording privacy's all-version closure.
 -- Seed annotation parents too: a direct revision read must check its message.
 WITH RECURSIVE causal_edges(parent_kind,parent_id,child_kind,child_id) AS NOT MATERIALIZED(
  SELECT d.resource_kind,d.resource_id,s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=w
  UNION ALL SELECT 'file_segment',f.id,'workspace_file',f.file_id FROM file_segments f WHERE f.workspace_id=w
 ), closure(kind,id) AS(
  SELECT 'session_message', (n->>'id')::uuid FROM jsonb_array_elements(nodes) n
   WHERE n->>'kind'='session_message' OR n->>'tag'='point' AND n->>'kind'='session_message_annotation'
  UNION SELECT 'session_message',r.parent_id FROM jsonb_array_elements(nodes) n JOIN session_context_scope_revisions r
   ON r.workspace_id=w AND r.id=(n->>'id')::uuid WHERE n->>'kind'='session_context_revision' AND r.parent_kind='message_annotation'
  UNION SELECT e.child_kind,e.child_id FROM closure c JOIN causal_edges e ON e.parent_kind=c.kind AND e.parent_id=c.id
 ), reached AS MATERIALIZED(SELECT * FROM closure LIMIT 4097), denied(kind,id) AS(
  SELECT r.kind,r.id FROM reached r JOIN workspace_files f ON r.kind='workspace_file' AND f.workspace_id=w AND f.id=r.id
   WHERE f.purpose='engineering_archive'
  UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN causal_edges e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id
 ) SELECT (SELECT count(*) FROM reached),coalesce(jsonb_object_agg(kind||':'||id,true),'{}') INTO archive_count,archive_denied FROM denied;
 IF archive_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('denied',result,'archiveDenied',archive_denied,'recordingEligible',conversation_recording_scope(w,session_ids));
END $body$;
REVOKE ALL ON FUNCTION conversation_capture_privacy(uuid,jsonb) FROM PUBLIC,app_user;

-- [COMP:api/native-turn-frame] Native rows have one current-snapshot owner.
-- Private graph helpers: complete all-version privacy must precede these reads.
CREATE OR REPLACE FUNCTION public.conversation_message_snapshot(w uuid, i uuid, archive_denied jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 k constant text:='session_message';snapshot jsonb; parent sessions; member_role text; projects uuid[]; v2 boolean;
BEGIN
 IF jsonb_typeof(archive_denied) IS DISTINCT FROM 'object' OR archive_denied ? ('session_message:'||i) THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 IF actor IS NULL
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT role INTO member_role FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 -- Lock the parent before the exact message snapshot. Its audience and bound
 -- context remain authority. A historical message missing that floor cannot
 -- certify a new file without canonical reclassification of the source.
 SELECT s.* INTO parent FROM sessions s
  JOIN session_messages m ON m.session_id=s.id
  JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=w
  WHERE m.id=i AND m.workspace_id=w AND (s.workspace_id IS NULL OR s.workspace_id=w)
  FOR SHARE OF s;
 IF NOT FOUND OR (parent.visibility='personal' AND parent.user_id IS DISTINCT FROM actor)
  OR (parent.visibility='workspace' AND parent.workspace_id IS DISTINCT FROM w) THEN RETURN NULL; END IF;
 IF parent.context_group_id IS NOT NULL THEN
  PERFORM id FROM workspace_groups WHERE id=parent.context_group_id AND workspace_id=w AND kind='team' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF workflow_evidence_envelope_visible(w,jsonb_build_object(
   'workspaceId',w,'userId',CASE WHEN parent.visibility='personal' THEN parent.user_id ELSE NULL END,
   'assistantId',NULL,'sensitivity',coalesce(parent.effective_clearance,'public'),
   'compartments',to_jsonb(coalesce(parent.context_compartments,'{}'::text[])),
   'projectIds',CASE WHEN parent.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(parent.context_project_id) END)) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
  'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids,'resourceKind',k,'resourceId',i,
  'version',m.scope_version::text,'held',m.scope_held,'validTo',NULL,'retractedAt',NULL)
 INTO snapshot FROM session_messages m WHERE m.workspace_id=w AND m.id=i AND m.scope_version IS NOT NULL FOR SHARE;
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(snapshot->>'userId')::uuid,(snapshot->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 -- Keep exact source snapshots: reject an incomplete parent floor rather
 -- than silently rewriting the source version/envelope or widening a file.
 IF (parent.visibility='personal' AND snapshot->>'userId' IS DISTINCT FROM parent.user_id::text)
  OR NOT(snapshot->'compartments' @> to_jsonb(coalesce(parent.context_compartments,'{}'::text[])))
  OR (parent.context_project_id IS NOT NULL
    AND NOT(snapshot->'projectIds' @> jsonb_build_array(parent.context_project_id)
      OR snapshot->'compartments' @> jsonb_build_array('project:'||parent.context_project_id::text))) THEN RETURN NULL; END IF;
 projects:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 IF parent.context_project_id IS NOT NULL THEN projects:=array_append(projects,parent.context_project_id); END IF;
 PERFORM id FROM workspace_projects WHERE workspace_id=w AND id=ANY(projects) ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM unnest(projects) p WHERE NOT EXISTS(
   SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=p AND pr.status='active'
    AND (v2 OR member_role IN('owner','admin') OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=p AND pm.user_id=actor)))) THEN RETURN NULL; END IF;
 RETURN snapshot;
END $function$;

REVOKE ALL ON FUNCTION conversation_message_snapshot(uuid,uuid,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_revision_snapshot(w uuid, i uuid, archive_denied jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE revision session_context_scope_revisions;root jsonb;parent jsonb;source jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 -- The owning graph already admitted complete all-version privacy.
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 SELECT * INTO revision FROM session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=i FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}'::jsonb; END IF;
 IF revision.parent_kind='turn_frame' AND native_turn_frame_pair(w,i) IS NOT TRUE THEN RETURN '{"held":true}'::jsonb;END IF;
 IF revision.scope_held OR scope_review_state_held('session_context_revision',i)
  OR NOT EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i)
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=w AND s.id=revision.session_id)
  OR revision.parent_kind='message_annotation' AND NOT EXISTS(SELECT 1 FROM session_messages m
    WHERE m.id=revision.parent_id AND m.session_id=revision.session_id AND m.workspace_id=w)
  OR revision.parent_kind IN('compact_summary','session_title') AND revision.parent_id<>revision.session_id
  OR revision.parent_kind='session_state' AND NOT EXISTS(SELECT 1 FROM session_state s
    WHERE s.id=revision.parent_id AND s.session_id=revision.session_id)
  OR revision.parent_kind='episodic_memory' AND NOT EXISTS(SELECT 1 FROM episodic_memories e
    WHERE e.id=revision.parent_id AND e.session_id=revision.session_id)
 THEN RETURN '{"held":true}'::jsonb; END IF;
 root:=jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,
  'userId',revision.user_id,'assistantId',revision.assistant_id,'sensitivity',revision.sensitivity,
  'compartments',revision.compartments,'projectIds',revision.project_ids,'version',revision.scope_version::text,
  'held',false,'validTo',NULL,'retractedAt',NULL);
 parent:=session_context_parent_snapshot(w,revision.session_id);
 IF revision.parent_kind='message_annotation' AND conversation_message_snapshot(w,revision.parent_id,archive_denied)->>'held' IS DISTINCT FROM 'false'
  OR parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE
  OR agent_visibility_allows(w,revision.user_id,revision.assistant_id) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,'session_context_revision',i,'1')) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(source)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $function$;

REVOKE ALL ON FUNCTION conversation_revision_snapshot(uuid,uuid,jsonb) FROM PUBLIC,app_user;

-- [COMP:api/native-turn-frame] One bounded, bottom-up conversation evaluator.
CREATE OR REPLACE FUNCTION public.conversation_dag(w uuid, roots jsonb, selectors jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE seeds jsonb;nodes jsonb;edges jsonb;children jsonb;memo jsonb:='{}';slots jsonb;completed jsonb[];flat jsonb;privacy jsonb;
 current_node jsonb;k text;kind text;node_id uuid;node_version text;entity_id uuid;result jsonb;source jsonb;node_value jsonb;envelope jsonb;valid boolean;
 positions jsonb;reverse_edges jsonb;degree_map jsonb;degrees integer[];queue integer[]:='{}';cursor_index integer:=1;item integer;parent_index integer;node_count integer;
 resource application_field_resources;observation application_field_observations;fields text[];dependency record;policy jsonb;mask jsonb;type_key text;deadline timestamptz;
BEGIN
 SELECT coalesce(jsonb_agg(n),'[]') INTO seeds FROM(
  SELECT value||'{"tag":"source"}'::jsonb n FROM jsonb_array_elements(roots)
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,'fields',
   (SELECT jsonb_agg(f ORDER BY f) FROM unnest(application_session_field_keys(q->>'type')) f))
  FROM jsonb_array_elements(selectors) q JOIN session_messages m ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) selected;
 WITH RECURSIVE closure(n) AS(
  SELECT value FROM jsonb_array_elements(seeds)
  UNION SELECT e FROM closure c CROSS JOIN LATERAL conversation_dag_edges(w,c.n) e
 ) SELECT coalesce(jsonb_agg(n),'[]') INTO nodes FROM(SELECT n FROM closure LIMIT 4097) bounded;
 IF jsonb_array_length(nodes)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('parent',n,'child',e,'edge_kind','derivation')),'[]') INTO edges
 FROM (SELECT n,e FROM jsonb_array_elements(nodes) n CROSS JOIN LATERAL conversation_dag_edges(w,n) e LIMIT 65537) bounded_edges;
 IF jsonb_array_length(edges)>65536 OR pg_column_size(nodes)+pg_column_size(edges)>16777216 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Intern the existing node set once. The old graph facade sorted, repacked
 -- and decoded the same nodes/edges before constructing this dependency queue.
 node_count:=jsonb_array_length(nodes);
 SELECT jsonb_object_agg(native_turn_key(n),position) INTO positions
 FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE native_turn_key(n) IS NULL)
  OR (SELECT count(*) FROM jsonb_object_keys(positions))<>node_count THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 WITH indexed AS MATERIALIZED(
  SELECT DISTINCT (positions->>native_turn_key(e->'parent'))::integer p,
   (positions->>native_turn_key(e->'child'))::integer c FROM jsonb_array_elements(edges) e
 ), reverse AS(SELECT c,jsonb_agg(p) parents FROM indexed GROUP BY c), degree AS(SELECT p,count(*) n FROM indexed GROUP BY p)
 SELECT (SELECT jsonb_object_agg(c,parents) FROM reverse),(SELECT jsonb_object_agg(p,n) FROM degree)
 INTO reverse_edges,degree_map;
 SELECT coalesce(array_agg(coalesce((degree_map->>i::text)::integer,0) ORDER BY i),'{}') INTO degrees FROM generate_series(1,node_count) i;
 FOR item IN 1..node_count LOOP IF degrees[item]=0 THEN queue:=array_append(queue,item);END IF;END LOOP;
 WHILE cursor_index<=cardinality(queue) LOOP
  item:=queue[cursor_index];cursor_index:=cursor_index+1;
  FOR parent_index IN SELECT value::integer FROM jsonb_array_elements_text(coalesce(reverse_edges->item::text,'[]')) LOOP
   degrees[parent_index]:=degrees[parent_index]-1;
   IF degrees[parent_index]=0 THEN queue:=array_append(queue,parent_index);END IF;
  END LOOP;
 END LOOP;
 IF cardinality(queue)<>node_count THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_object_agg(key,items),'{}') INTO children FROM(
  SELECT native_turn_key(e->'parent') key,jsonb_agg(e->'child') items FROM jsonb_array_elements(edges) e GROUP BY 1
 ) grouped;
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM (
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT audience_deadlines.expires_at FROM (SELECT CASE WHEN pg_input_is_valid(binding->>'expiresAt','timestamp with time zone')
   THEN (binding->>'expiresAt')::timestamptz ELSE NULL END AS expires_at
  FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ci.config->'deliveryAudienceBindings')='array'
   THEN ci.config->'deliveryAudienceBindings' ELSE '[]'::jsonb END) binding
  WHERE c.workspace_id=w AND c.status='active' AND ci.status='active') audience_deadlines
  WHERE audience_deadlines.expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM external_source_authorizations
  WHERE workspace_id=w AND transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
   AND operation_id::text=nullif(current_setting('app.external_source_operation_id',true),'')
   AND observation_id IN(SELECT (n->>'id')::uuid FROM jsonb_array_elements(nodes) n
    WHERE n->>'kind'='external_source')
 UNION ALL SELECT to_timestamp((o.observation#>>'{retention,expiresAt}')::numeric/1000)
  FROM external_source_observations o JOIN jsonb_array_elements(nodes) n
   ON n->>'kind'='external_source' AND o.workspace_id=w AND o.id=(n->>'id')::uuid
  WHERE o.observation#>>'{retention,mode}'='released_snapshot') transitions;
 privacy:=conversation_capture_privacy(w,nodes);
 memo:=jsonb_build_object('privacyDenied',privacy->'denied','archiveDenied',privacy->'archiveDenied','recordingEligible',privacy->'recordingEligible','validUntil',deadline,'hasExternal',EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='external_source'),
  'points','{}'::jsonb,'domains','{}'::jsonb,'envelopes','{}'::jsonb,'current','{}'::jsonb);
 -- Expanded PostgreSQL arrays update completed slots without copying every
 -- earlier point, envelope and source at each graph vertex.
 SELECT jsonb_object_agg(label,slot) INTO slots FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position)
 CROSS JOIN LATERAL (
  SELECT CASE WHEN n->>'tag'='point' THEN 'points:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   WHEN n->>'kind'='application_field' THEN 'field:'||(n->>'id')||':'||(n->>'version')
   WHEN n->>'kind'='application_query_domain' THEN 'domains:'||(n->>'id')
   ELSE 'native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END label,position*2-1 slot
  UNION ALL SELECT CASE WHEN n->>'tag'='point' THEN 'envelopes:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   ELSE 'current:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END,position*2
 ) aliases;
 completed:=array_fill(NULL::jsonb,ARRAY[jsonb_array_length(nodes)*2]);
 FOREACH item IN ARRAY queue LOOP
  current_node:=nodes->(item-1);k:=native_turn_key(current_node);kind:=current_node->>'kind';node_id:=(current_node->>'id')::uuid;node_version:=current_node->>'version';node_value:=NULL;source:=NULL;envelope:=NULL;
  IF current_node->>'tag'='point' THEN
   fields:=ARRAY(SELECT jsonb_array_elements_text(current_node->'fields'));
   IF NOT (memo->'privacyDenied') ? ('application_field:'||application_field_resource_uuid(application_field_digest(jsonb_build_object(
    'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',kind,'id',node_id,
    'selection','query','selectedVersion',NULL,'fields',fields,'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',kind,'fields',fields)))))) THEN
    result:=conversation_dag_point(w,kind,node_id,fields,memo,slots,completed);node_value:=result->'value';
   END IF;
   completed[(slots->>('points:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=node_value;
   envelope:=conversation_dag_envelope(w,kind,node_id,'query',fields,memo,slots,completed)->'value';
   completed[(slots->>('envelopes:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=envelope;
  ELSIF kind='application_field' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND application_field_resources.id=node_id;
   SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=node_id AND application_field_observations.version=node_version;
   IF resource.id IS NOT NULL AND observation.resource_id IS NOT NULL AND NOT scope_review_state_held('application_field',node_id) THEN
    IF resource.origin='{"kind":"native","moduleKey":"native"}' AND (resource.type_key IN('session_message','session_message_annotation')
     OR resource.type_key='memory' AND resource.selection IN('read','query','identity','query_domain')) THEN
     IF resource.selected_version IS NULL THEN
      envelope:=conversation_dag_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,slots,completed)->'value';
      valid:=envelope IS NOT NULL AND envelope->>'identity'=resource.identity
       AND (envelope#>>'{state,policyVersion}'=observation.policy_version
        OR resource.type_key='memory' AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version)
       AND workflow_evidence_envelope_visible(w,observation.source_scope) AND workflow_evidence_envelope_visible(w,envelope->'source');
      FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=node_id AND application_field_observation_sources.version=node_version LOOP
       IF dependency.source_kind='application_field' THEN source:=completed[(slots->>('field:'||dependency.source_id||':'||dependency.source_version))::integer]->'value';
       ELSE source:=completed[(slots->>('current:external_source:'||dependency.source_id||':'||dependency.source_version))::integer];END IF;
       IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR dependency.source_kind='external_source' AND source->>'version' IS DISTINCT FROM dependency.source_version THEN valid:=false;END IF;
      END LOOP;
      IF valid THEN node_value:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);END IF;
     END IF;
    ELSE node_value:=application_recorded_field_state_before_session_eval(w,node_id,node_version,0);END IF;
   END IF;
   completed[(slots->>('field:'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',node_value,'envelope',envelope,'external','[]'::jsonb);
  ELSIF kind='application_query_domain' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND resource_id=node_id AND selection='query_domain' LIMIT 1;
   IF resource.origin='{"kind":"native","moduleKey":"native"}' AND resource.type_key IN('session_message','session_message_annotation') THEN
    result:=conversation_dag_domain(w,resource.type_key,node_id,resource.fields,memo,slots,completed);
    completed[(slots->>('domains:'||node_id))::integer]:=result-'memo';
   END IF;
  ELSE
   valid:=true;
   IF (memo->'privacyDenied') ? (kind||':'||node_id) THEN valid:=false;
   ELSIF kind='external_source' THEN
    source:=external_source_snapshot(w,node_id);valid:=source IS NOT NULL AND source->>'held'='false' AND source->>'version'=node_version;
   ELSIF kind='session_message' THEN
    source:=conversation_message_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false'
     OR NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND id=node_id);
   ELSIF kind='session_context_revision' THEN
    source:=conversation_revision_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false';
   ELSIF scope_source_table(kind) IS NOT NULL OR kind IN('private_transcript','crm_event','page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
    source:=read_admitted_native_scope_snapshot(w,kind,node_id);
    IF kind IN('session_context_revision','crm_event','private_transcript') AND source IS NULL OR source IS NOT NULL AND source->>'held' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    IF kind='private_transcript' AND source->>'version' IS DISTINCT FROM node_version THEN valid:=false;END IF;
   END IF;
   FOR dependency IN SELECT c FROM jsonb_array_elements(coalesce(children->k,'[]')) c WHERE c->>'tag'='source' LOOP
    IF dependency.c->>'kind'='application_field' THEN
     IF completed[(slots->>('field:'||(dependency.c->>'id')||':'||(dependency.c->>'version')))::integer]#>>'{value,held}' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    ELSIF dependency.c->>'kind'<>'application_query_domain' AND completed[(slots->>('native:'||(dependency.c->>'kind')||':'||(dependency.c->>'id')||':'||(dependency.c->>'version')))::integer]->>'value' IS DISTINCT FROM 'true' THEN valid:=false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=kind AND d.resource_id=node_id LOOP
    IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
     'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN valid:=false;END IF;
    FOR type_key,entity_id IN SELECT e.kind,e.id FROM scope_derivation_sources ds JOIN entities e ON e.workspace_id=w AND e.id=ds.source_id
     WHERE ds.workspace_id=w AND ds.derivation_id=dependency.id AND ds.source_kind='entity' AND e.kind IN('company','person','deal') LOOP
     policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id::text);
     IF policy->>'registered' IS DISTINCT FROM 'false' THEN
      mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id);
      IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
       OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN valid:=false;END IF;
     END IF;
    END LOOP;
   END LOOP;
   node_id:=(current_node->>'id')::uuid;
   completed[(slots->>('native:'||kind||':'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',valid,'external','[]'::jsonb);
   completed[(slots->>('current:'||kind||':'||node_id||':'||node_version))::integer]:=source;
  END IF;
 END LOOP;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_object_agg(key,completed[value::integer]),'{}') INTO flat FROM jsonb_each_text(slots);
 SELECT memo||coalesce(jsonb_object_agg(key,value) FILTER(WHERE key LIKE 'field:%' OR key LIKE 'native:%'),'{}')
  ||jsonb_build_object(
   'points',coalesce(jsonb_object_agg(substring(key FROM 8),value) FILTER(WHERE key LIKE 'points:%'),'{}'),
   'envelopes',coalesce(jsonb_object_agg(substring(key FROM 11),value) FILTER(WHERE key LIKE 'envelopes:%'),'{}'),
   'domains',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'domains:%'),'{}'),
   'current',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'current:%'),'{}'))
 INTO memo FROM jsonb_each(flat);
 RETURN memo;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag(uuid,jsonb,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_domain(w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;result jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;state jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN '{}'::jsonb;END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN '{}'::jsonb;END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN '{}'::jsonb;END IF;
 result:=conversation_dag_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,slots,completed);

 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN '{}'::jsonb;END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'children',result->'children');
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_edges(w uuid, n jsonb)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF n->>'tag'='source' THEN
 RETURN QUERY SELECT jsonb_build_object('tag','source','kind',e.kind,'id',e.id,'version',e.version)
 FROM conversation_source_edges(w,n->>'kind',(n->>'id')::uuid,n->>'version') e WHERE n->>'tag'='source'
 UNION SELECT jsonb_build_object('tag','point','kind',r.type_key,'id',r.resource_id,'fields',r.fields)
 FROM application_field_resources r WHERE n->>'tag'='source' AND n->>'kind'='application_field'
  AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.origin='{"kind":"native","moduleKey":"native"}'
  AND r.type_key IN('session_message','session_message_annotation') AND r.selection IN('query','identity','read') AND r.selected_version IS NULL
 UNION SELECT jsonb_build_object('tag','point','kind',q.type_key,'id',m.id,'fields',q.domain->'fields')
 FROM application_query_domains q JOIN session_messages m ON m.workspace_id=w AND m.session_id=(q.domain->>'sessionId')::uuid
  AND m.sequence_num<=(q.domain->>'throughSequence')::integer
 WHERE n->>'tag'='source' AND n->>'kind'='application_query_domain' AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  AND q.origin='{"kind":"native","moduleKey":"native"}' AND q.type_key IN('session_message','session_message_annotation')
 ;
 ELSE
 RETURN QUERY SELECT jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text)
 FROM session_messages m WHERE n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
 UNION SELECT jsonb_build_object('tag','source','kind','session_context_revision','id',r.id,'version',r.scope_version::text)
 FROM session_message_annotation_heads h JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
  AND r.session_id=h.session_id AND r.parent_kind='message_annotation' AND r.parent_id=h.message_id
 WHERE n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND h.workspace_id=w AND h.message_id=(n->>'id')::uuid
;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_edges(uuid,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_envelope(w uuid, t text, i uuid, selection text, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF t NOT IN('session_message','session_message_annotation','memory') OR selection NOT IN('read','query','identity','query_domain') THEN RETURN '{}'::jsonb;END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN '{}'::jsonb;END IF;
 IF t='memory' THEN
  -- The family owns current selected fields, complete cohorts and successors.
  -- The DAG owns original field obligations; do not recursively capture them
  -- again through application_recorded_field_state_before_session_eval.
  state:=CASE WHEN selection='query_domain' THEN application_memory_query_domain_state(w,i,keys) ELSE application_memory_field_state(w,i,keys) END;
 ELSE
  IF selection='query_domain' THEN
   result:=completed[(slots->>('domains:'||i))::integer];children:=coalesce(result->'children','[]'::jsonb);
  ELSE result:=jsonb_build_object('value',completed[(slots->>('points:'||jsonb_build_array(t,i,keys)::text))::integer]);END IF;
  memo:=coalesce(result->'memo',memo);state:=result->'value';
 END IF;
 IF state IS NULL OR state='null'::jsonb THEN RETURN '{}'::jsonb;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 IF coalesce(memo->>'hasExternal','true')='true' THEN
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN '{}'::jsonb;END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN '{}'::jsonb;END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_point(w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;checked jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean:=false;
 dependency record;admitted jsonb;projection jsonb;label jsonb;seen jsonb:='[]';immutable_scope jsonb;
BEGIN
 IF clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 -- Recording privacy admission precedes body selection.
 IF (memo->'privacyDenied') ? ('session_message:'||i) THEN RETURN '{}'::jsonb;END IF;
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Absence already returns NULL in the annotation branch below. Refuse it
 -- before the expensive parent proof, without changing scan identities or
 -- granting access. A present head still takes the original later head read,
 -- source admission and independent query-domain/currentness proofs.
 IF t='session_message_annotation' AND NOT EXISTS(
  SELECT 1 FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
  WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i
   AND r.parent_kind='message_annotation' AND r.parent_id=i AND r.session_id=m.session_id
 ) THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=completed[(slots->>('current:session_message:'||i||':'||m.scope_version))::integer];
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM m.scope_version::text
    THEN RETURN NULL;END IF;

  -- Only the first canonical history-bearing message uses complete per-original admission.
  IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources link ON link.workspace_id=d.workspace_id AND link.derivation_id=d.id
 CROSS JOIN LATERAL (
  SELECT link.source_kind,link.source_id,link.source_version WHERE link.source_kind<>'session_context_revision'
  UNION ALL
  SELECT edge.source_kind,edge.source_id,edge.source_version FROM native_turn_frames frame
   JOIN scope_derivations declaration ON declaration.workspace_id=frame.workspace_id
    AND declaration.resource_kind='session_context_revision' AND declaration.resource_id=frame.id AND declaration.resource_version='1'
   JOIN scope_derivation_sources edge ON edge.workspace_id=declaration.workspace_id AND edge.derivation_id=declaration.id
   WHERE link.source_kind='session_context_revision' AND link.source_version='1' AND frame.workspace_id=w
    AND frame.id=link.source_id AND frame.session_id=message.session_id AND frame.format=2
    AND (SELECT count(*) FROM scope_derivation_sources original WHERE original.workspace_id=w AND original.derivation_id=d.id)=1
    AND native_turn_frame_pair(w,frame.id) IS TRUE
 ) s
 WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=i) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

  END IF;
  IF history_shape IS TRUE THEN
   BEGIN
    IF application_reader_envelope_visible(w,source) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     SELECT o.source_scope INTO immutable_scope FROM application_field_observations o
      WHERE o.workspace_id=w AND o.resource_id=direct_ids[direct_position] AND o.version=direct_versions[direct_position];
     IF immutable_scope IS NULL OR workflow_evidence_envelope_visible(w,immutable_scope) IS NOT TRUE
      OR sensitivity_rank(immutable_scope->>'sensitivity')>sensitivity_rank(source->>'sensitivity')
      OR NOT (source->'compartments')@>(immutable_scope->'compartments') OR NOT (source->'projectIds')@>(immutable_scope->'projectIds')
      OR immutable_scope->>'userId' IS NOT NULL AND immutable_scope->>'userId' IS DISTINCT FROM source->>'userId'
       AND (source->>'userId' IS NOT NULL OR immutable_scope->>'userId' IS DISTINCT FROM actor::text)
      THEN RETURN '{}'::jsonb;END IF;
     IF EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
      projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]);
      IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
       OR projection->'root' IS DISTINCT FROM (immutable_scope||jsonb_build_object('resourceKind','application_field','resourceId',direct_ids[direct_position],'version',direct_versions[direct_position]))
       OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN RETURN '{}'::jsonb;END IF;
      FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
       IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
      END LOOP;
     ELSE
      -- Ordinary originals retain their stricter exact current-version check.
      admitted:=completed[(slots->>('field:'||direct_ids[direct_position]||':'||direct_versions[direct_position]))::integer]->'value';
      IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM direct_versions[direct_position]
       THEN RETURN '{}'::jsonb;END IF;
     END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     -- The helper admits the complete originals after metadata discovery.
     -- Transitive ordinary fields retain D1; their immutable tuple is not rewritten.
     IF dependency.source IS NULL OR dependency.source->>'resourceKind' IS DISTINCT FROM 'application_field'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
      OR NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w
       AND o.resource_id=(dependency.source->>'resourceId')::uuid AND o.version=dependency.node_version)
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
     seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
     IF jsonb_array_length(seen)>4096 THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT seen @> jsonb_build_array(jsonb_build_array(direct_ids[direct_position]::text,direct_versions[direct_position])) THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_external_source_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     admitted:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
     IF dependency.source IS NULL OR admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version OR admitted->>'version' IS DISTINCT FROM dependency.node_version
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE OR application_reader_envelope_visible(w,admitted) IS NOT TRUE
      THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    IF conversation_message_snapshot(w,i,memo->'archiveDenied') IS DISTINCT FROM source THEN RETURN '{}'::jsonb;END IF;
   EXCEPTION WHEN insufficient_privilege THEN RETURN '{}'::jsonb;END;
  ELSE
  checked:=conversation_dag_scope(w,'session_message',i,m.scope_version::text,memo,slots,completed);
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
  END IF;
  SELECT jsonb_build_object('id',id,'role',role,'content',content,'sequenceNum',sequence_num,'createdAt',created_at,
   'senderUserId',sender_user_id,'senderAssistantId',sender_assistant_id,'channelMessageId',channel_message_id,'attachments',attachments) INTO values_json
   FROM session_messages WHERE workspace_id=w AND id=i AND scope_version=m.scope_version;
  IF values_json IS NULL THEN RETURN NULL;END IF;
  source_kind:='session_message';source_id:=i;
  -- Selected payload changes remain distinct even when an old native writer
  -- changed text without advancing its scope envelope version.
  record_version:=m.scope_version::text||':'||application_field_digest(values_json);
 ELSE
  SELECT r.* INTO revision FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
   WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i AND r.parent_kind='message_annotation'
    AND r.parent_id=i AND r.session_id=m.session_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  checked:=conversation_dag_scope(w,'session_context_revision',revision.id,'1',memo,slots,completed);
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
  source:=(completed[(slots->>('current:session_context_revision:'||revision.id||':'||revision.scope_version))::integer])-'requiredSources';
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('value',jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_scan(w uuid, s uuid, t text, through integer, fields text[], bounds jsonb, visibility jsonb, memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;candidates jsonb;points jsonb;policies jsonb;children jsonb;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL THEN RETURN '{}'::jsonb;END IF;
 WITH selected AS MATERIALIZED(
  SELECT m.id,m.sequence_num,completed[(slots->>('envelopes:'||jsonb_build_array(t,m.id,fields)::text))::integer] point
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s AND m.sequence_num<=through
 ), admitted AS(
  SELECT * FROM selected q WHERE q.point IS NOT NULL AND q.point<>'null'::jsonb
   AND application_query_scope_admits_point(bounds,q.point->'source') IS TRUE
   AND(q.point#>>'{source,userId}' IS NULL OR q.point#>>'{source,userId}' IS NOT DISTINCT FROM visibility->>'userId')
   AND(q.point#>>'{source,assistantId}' IS NULL OR visibility->'assistants'='null'::jsonb
    OR coalesce(visibility->'assistants' ? (q.point#>>'{source,assistantId}'),false))
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'policy',point#>'{state,policyVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(point ORDER BY sequence_num,id),'[]') INTO candidates,points,policies,children FROM admitted;
 RETURN jsonb_build_object('value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_scope(w uuid, k text, i uuid, v text, memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('value',coalesce(completed[(slots->>('native:'||k||':'||i||':'||v))::integer]->>'value'='true',false))
$function$;
REVOKE ALL ON FUNCTION conversation_dag_scope(uuid,text,uuid,text,jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;


-- [COMP:api/native-turn-frame] Canonical conversation query capture.
CREATE OR REPLACE FUNCTION public.capture_conversation_selection(w uuid, s uuid, t text, through integer, fields text[], bounds jsonb, visibility jsonb, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;resource uuid;field_identity text;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL OR fields IS NULL
  OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF (SELECT count(*) FROM(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through LIMIT 4097) candidates)>4096
 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 -- The graph admits complete all-version privacy before selecting any point payload.
 FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id
 LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  point:=memo#>ARRAY['envelopes',jsonb_build_array(t,candidate.id,fields)::text];
  IF point IS NULL OR point='null'::jsonb OR application_query_scope_admits_point(bounds,point->'source') IS NOT TRUE
   OR point#>>'{source,userId}' IS NOT NULL AND point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false) THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}'));
  points:=points||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',point#>'{state,policyVersion}'));
  children:=children||jsonb_build_array(point);
 END LOOP;
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);
END $function$;
REVOKE ALL ON FUNCTION capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
CREATE OR REPLACE FUNCTION public.capture_conversation_query(w uuid, s uuid, body_through integer, topics_through integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;context jsonb;memo jsonb;scanned jsonb;captured jsonb;
 selections jsonb;initial jsonb;fresh jsonb;fields text[];selection jsonb;pass integer;frozen application_query_domains;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR body_through IS NULL AND topics_through IS NULL OR body_through<0 OR topics_through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 selections:=jsonb_build_array(jsonb_build_object('type','session_message','through',body_through,'sessionId',s),
  jsonb_build_object('type','session_message_annotation','through',topics_through,'sessionId',s));
 FOR pass IN 1..2 LOOP
  parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
  IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
  memo:=conversation_dag(w,'[]',(SELECT jsonb_agg(value) FROM jsonb_array_elements(selections) WHERE value->>'through' IS NOT NULL));fresh:='[]';
  FOR selection IN SELECT value FROM jsonb_array_elements(selections) WHERE value->>'through' IS NOT NULL LOOP
   fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(selection->>'type')) field ORDER BY field);
   scanned:=capture_conversation_selection(w,s,selection->>'type',(selection->>'through')::integer,fields,bounds,visibility,memo);
   memo:=scanned->'memo';
   IF scanned->'value' IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   captured:=native_turn_build_query_capture(w,s,selection->>'type',(selection->>'through')::integer,fields,parent,bounds,visibility,scanned);
   IF recording_source_read_allowed(w,'application_field',(captured#>>'{envelope,resourceId}')::uuid) IS NOT TRUE
    OR scope_review_state_held('application_field',(captured#>>'{envelope,resourceId}')::uuid)
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   fresh:=fresh||jsonb_build_array(captured);
  END LOOP;
  IF pass=1 THEN
   initial:=fresh;
   FOR captured IN SELECT value FROM jsonb_array_elements(initial) LOOP
    INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
     VALUES((captured->>'domainId')::uuid,w,'{"kind":"native","moduleKey":"native"}',captured->>'type','1',captured->'domain',captured->>'domainIdentity') ON CONFLICT DO NOTHING;
    SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=(captured->>'domainId')::uuid;
    IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM
     ('{"kind":"native","moduleKey":"native"}'::jsonb,captured->>'type','1',captured->'domain',captured->>'domainIdentity')
    THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
    PERFORM application_materialize_field_envelope(w,captured->'envelope');
   END LOOP;
  ELSIF fresh IS DISTINCT FROM initial THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('history',coalesce((SELECT c->'rows' FROM jsonb_array_elements(initial) c WHERE c->>'type'='session_message'),'[]'::jsonb),
  'annotations',coalesce((SELECT c->'rows' FROM jsonb_array_elements(initial) c WHERE c->>'type'='session_message_annotation'),'[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION capture_conversation_query(uuid,uuid,integer,integer) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION capture_conversation_query(uuid,uuid,integer,integer) TO app_user;

CREATE FUNCTION capture_conversation_evidence(w uuid,roots jsonb,authority jsonb DEFAULT NULL,cohorts jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical jsonb;memo jsonb;n jsonb;source jsonb;immutable jsonb:='[]';currents jsonb:='[]';observation application_field_observations;key text;context jsonb;policy_revision jsonb;dependency record;authority_facts jsonb;groups jsonb;membership jsonb;cohort integer;proofs jsonb:='[]';selector record;candidate record;candidate_sources jsonb:='[]';attempts integer:=0;
BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 -- Cohorts are separate evidence floors in one physical capture. Their shared
 -- graph is evaluated once; membership never widens either returned floor.
 IF cohorts IS NOT NULL THEN
  IF roots IS NOT NULL OR authority IS NOT NULL OR jsonb_typeof(cohorts) IS DISTINCT FROM 'array'
   OR jsonb_array_length(cohorts)<>2 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  FOR groups IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
   IF jsonb_typeof(groups) IS DISTINCT FROM 'array' OR jsonb_array_length(groups) NOT BETWEEN 1 AND 4096
   THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  END LOOP;
  SELECT jsonb_agg(DISTINCT item.node) INTO roots FROM jsonb_array_elements(cohorts) g CROSS JOIN jsonb_array_elements(g) item(node);
 END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 groups:=coalesce(cohorts,jsonb_build_array(roots));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object' OR input.root-ARRAY['kind','id','version']<>'{}'
  OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid')) THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 -- Query-domain identities are internal dependencies, never source roots.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root WHERE root->>'kind'='application_query_domain') THEN RETURN NULL;END IF;
 -- Source-family readers lock their native rows. Fence policy changes once
 -- across acquisition, without treating an uncommitted administrative lock as denial.
 SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 WITH RECURSIVE closure(cohort,kind,id,version) AS(
  SELECT g.position,r->>'kind',(r->>'id')::uuid,r->>'version'
   FROM jsonb_array_elements(groups) WITH ORDINALITY g(roots,position) CROSS JOIN jsonb_array_elements(g.roots) r
  UNION SELECT c.cohort,e.kind,e.id,e.version FROM closure c CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO membership FROM(SELECT * FROM closure LIMIT CASE WHEN cohorts IS NULL THEN 4097 ELSE 8193 END) c;
 IF jsonb_array_length(membership)>8192 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(DISTINCT member.node-'cohort'),'[]') INTO physical FROM jsonb_array_elements(membership) member(node);
 IF jsonb_array_length(physical)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 IF cohorts IS NULL AND jsonb_array_length(roots)=1 AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(roots->0->>'id')::uuid
  AND roots->0->>'kind'='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  RETURN read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(roots->0->>'id')::uuid],ARRAY[roots->0->>'version']);
 END IF;
 -- Separate purpose/family adapters own independent source receipts and Memory
 -- history qualification. This operation does not speculate through those APIs.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x WHERE x->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','memory','workspace_file','episode','recording','private_transcript'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x JOIN application_field_resources f ON f.workspace_id=w AND f.id=(x->>'id')::uuid
   WHERE x->>'kind'='application_field' AND (f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR f.type_key NOT IN('session_message','session_message_annotation','memory') OR f.type_key='memory' AND f.selection='history'))
 THEN RETURN NULL;END IF;
 -- Stored result ancestry omits source-denied semantic candidates. Preserve
 -- the Memory family's complete-current-cohort discovery before claiming a
 -- native proof; metadata alone cannot substitute for external admission.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=(x->>'id')::uuid WHERE x->>'kind'='application_field'
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain') THEN
  -- The canonical closure already owns ancestry. The old cohort facade
  -- walked it again through a 100-root API and refused larger valid captures.
  FOR selector IN SELECT DISTINCT q.domain FROM jsonb_to_recordset(physical) n(kind text,id uuid,version text)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
   JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
   JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain' LOOP
   IF selector.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE
   THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   IF selector.domain->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
   FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP
    attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
    source:=read_scope_source(w,'memory',candidate.id);
    IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(selector.domain->'bounds',source) IS NOT TRUE THEN CONTINUE;END IF;
    candidate_sources:=candidate_sources||jsonb_build_array(jsonb_build_object('kind','memory','id',candidate.id,'version',source->'version'));
   END LOOP;
  END LOOP;
  FOR dependency IN SELECT array_agg(cohort_source.node->>'kind') kinds,
   array_agg((cohort_source.node->>'id')::uuid) ids,array_agg(cohort_source.node->>'version') versions
   FROM jsonb_array_elements(candidate_sources) WITH ORDINALITY cohort_source(node,ord)
   GROUP BY (cohort_source.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;
 memo:=conversation_dag(w,roots,'[]');
 -- A denied semantic query candidate can become readable through an independent
 -- source. Its coordinator must reevaluate that complete candidate cohort.
 IF memo->>'hasExternal'='true' OR memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 FOR cohort IN 1..jsonb_array_length(groups) LOOP
 immutable:='[]';currents:='[]';
 FOR n IN SELECT x-'cohort' FROM jsonb_array_elements(membership) x WHERE (x->>'cohort')::integer=cohort LOOP
  IF n->>'kind'='application_query_domain' THEN CONTINUE;END IF;
  IF n->>'kind'='application_field' THEN
   source:=memo#>ARRAY['field:'||(n->>'id')||':'||(n->>'version'),'value'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(n->>'id')::uuid AND version=n->>'version';
   immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  ELSE
   IF memo#>>ARRAY['native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'value'] IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
   source:=memo#>ARRAY['current',(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')];
   IF source IS NULL OR source='null'::jsonb THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
   IF n->>'kind'='session_context_revision' THEN
    IF source->>'version' IS DISTINCT FROM n->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    immutable:=immutable||jsonb_build_array(source);
   END IF;
  END IF;
  currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 proofs:=proofs||jsonb_build_array(jsonb_build_object('immutable',immutable,'current',currents));
 END LOOP;
 IF authority IS NOT NULL THEN
  IF jsonb_typeof(authority) IS DISTINCT FROM 'array' OR jsonb_array_length(authority)<>9
   OR authority->>0 IS DISTINCT FROM w::text OR authority->>1 IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  authority_facts:=read_session_authority_facts((authority->>0)::uuid,(authority->>1)::uuid,(authority->>2)::uuid,(authority->>3)::uuid,
    (authority->>4)::uuid,(authority->>5)::integer,(authority->>6)::uuid,(authority->>7)::boolean,(authority->>8)::boolean);
 END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;

 RETURN jsonb_build_object('admitted',true)||CASE WHEN cohorts IS NULL THEN proofs->0 ELSE jsonb_build_object('cohorts',proofs) END
  ||CASE WHEN authority IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('authority',authority_facts) END;
END $$;
REVOKE ALL ON FUNCTION capture_conversation_evidence(uuid,jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION capture_conversation_evidence(uuid,jsonb,jsonb,jsonb) TO app_user;

-- [COMP:api/native-turn-frame] Title readers consume canonical frames at their existing boundary.
DO $title_evidence_owner$ DECLARE signature text;definition text;
 old_proof constant text:=$old$ proof:=read_native_file_session_evidence(w,ARRAY(SELECT 'session_context_revision'::text FROM unnest(revision_ids)),revision_ids,
  ARRAY(SELECT '1'::text FROM unnest(revision_ids)),true);$old$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['read_native_personal_title_group(uuid,uuid[],uuid[])','native_personal_title_group_acquisition(uuid,uuid[],uuid[])'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF strpos(definition,old_proof)=0 THEN RAISE EXCEPTION 'conversation_title_evidence_predecessor_changed';END IF;
  EXECUTE replace(definition,old_proof,$new$ proof:=capture_conversation_evidence(w,(SELECT jsonb_agg(jsonb_build_object(
   'kind','session_context_revision','id',id,'version','1') ORDER BY ordinal)
   FROM unnest(revision_ids) WITH ORDINALITY input(id,ordinal)));$new$);
 END LOOP;
END $title_evidence_owner$;

-- The current-head reader follows publication's workspace-before-head lock
-- order. Capture then admits the revision before the payload is selected.
DO $title_head_owner$ DECLARE definition text;previous constant text:=
 ' SELECT h.scope_revision_id INTO current_revision FROM session_title_heads h';BEGIN
 definition:=pg_get_functiondef('read_session_title_revision(uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'conversation_title_head_predecessor_changed';END IF;
 EXECUTE replace(definition,previous,' PERFORM id FROM workspaces WHERE id=w FOR SHARE;'||chr(10)||previous);
END $title_head_owner$;

-- [COMP:api/native-turn-frame] Canonical row-level turn-frame admission.
DO $revision_access$
DECLARE definition text;previous text:=$old$ IF EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i AND r.parent_kind='turn_frame')
  AND native_turn_helpers_current() IS TRUE THEN
  chat_proof:=read_native_turn_requirements(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')));
  IF chat_proof->>'available'='true' THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
 END IF;$old$;
BEGIN
 definition:=pg_get_functiondef('session_context_revision_allowed(uuid,uuid)'::regprocedure);
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'conversation_revision_access_predecessor_changed';END IF;
 EXECUTE replace(definition,previous,$new$ IF EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i AND r.parent_kind IN('turn_frame','session_title'))
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
   WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  chat_proof:=capture_conversation_evidence(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')));
  IF chat_proof IS NOT NULL THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
 END IF;$new$);
END $revision_access$;

-- [COMP:api/application-persistence] One native acquisition, explicit family adapters.
CREATE OR REPLACE FUNCTION read_native_session_field_snapshots(w uuid,ids uuid[],versions text[])
RETURNS TABLE(ord integer,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE roots jsonb;memo jsonb;context jsonb;policy_revision jsonb;entry record;owner_login boolean;
BEGIN
 IF ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096 OR cardinality(ids)<>cardinality(versions)
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL
  OR array_ndims(ids)<>1 OR array_lower(ids,1)<>1 OR array_ndims(versions)<>1 OR array_lower(versions,1)<>1
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
  WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
 INTO owner_login;
 SELECT coalesce(jsonb_agg(root),'[]') INTO roots FROM (
  SELECT DISTINCT jsonb_build_object('kind','application_field','id',input.id,'version',input.version) root
  FROM unnest(ids,versions) input(id,version) JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id
  WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key IN('session_message','session_message_annotation')
 ) native;
 IF roots<>'[]' AND NOT owner_login THEN
  IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  context:=native_turn_context();
  SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  memo:=conversation_dag(w,roots,'[]');
 END IF;
 FOR entry IN SELECT input.*,f.origin,f.type_key FROM unnest(ids,versions) WITH ORDINALITY input(id,version,position)
  LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id ORDER BY input.position LOOP
  IF entry.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND entry.type_key IN('session_message','session_message_annotation') THEN
   snapshot:=coalesce(nullif(memo#>ARRAY['field:'||entry.id||':'||entry.version,'value'],'null'::jsonb),'{"held":true}'::jsonb);
  ELSE
   snapshot:=read_admitted_application_field_snapshot(w,entry.id,entry.version);
  END IF;
  ord:=entry.position;RETURN NEXT;
 END LOOP;
 -- PL/pgSQL buffers SETOF results: no row escapes before this final fence.
 IF memo IS NOT NULL AND (native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
END $body$;
$sources$,'__CONTEXT_GUARD_FINGERPRINT__',pin);
END $replace$;
-- A known new trigger adapter is enrolled from the reviewed source above.
INSERT INTO conversation_before
 SELECT p.oid,p.oid::regprocedure::text,to_jsonb(p),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p WHERE p.oid='native_turn_capture_event()'::regprocedure;
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_capture_event()'::regprocedure;
-- The retired queue's two table contracts disappear with its tables. Preserve
-- the source FK contract; replace only the authenticated trigger roster after
-- the single reviewed trigger substitution under the relation's DDL lock.
DELETE FROM conversation_contract_predicates WHERE strpos(predicate,'native_field_dependency_batches')>0;
INSERT INTO conversation_contract_predicates
 SELECT '(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=''public.scope_derivation_sources''::regclass) IS NOT DISTINCT FROM '
  ||quote_literal(jsonb_agg(to_jsonb(t) ORDER BY t.oid)::text)||'::jsonb'
 FROM pg_trigger t WHERE t.tgrelid='public.scope_derivation_sources'::regclass;

DO $event_completion_owner$ DECLARE signature text;definition text;old_lookup constant text:='frame_id=selected_frame;';BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(signature));
  IF strpos(definition,'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=selected_frame;')=0
  THEN RAISE EXCEPTION 'conversation_event_predecessor_changed';END IF;
  definition:=replace(definition,'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=selected_frame;',
   'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=coalesce(work.completion_owner,selected_frame);');
  definition:=replace(definition,'WHERE n->>''derivationId''=output.id::text','WHERE (work.completion_owner IS NULL OR n->>''frameId''=selected_frame::text) AND n->>''derivationId''=output.id::text');
  EXECUTE definition;
 END LOOP;
END $event_completion_owner$;
DO $title_event_owner$ DECLARE definition text;signature text;BEGIN
 definition:=pg_get_functiondef('native_turn_event_frame(uuid,uuid)'::regprocedure);
 IF strpos(definition,'r.parent_kind=''message_annotation''')=0 THEN RAISE EXCEPTION 'conversation_title_event_predecessor_changed';END IF;
 EXECUTE replace(definition,'r.parent_kind=''message_annotation''','r.parent_kind IN(''message_annotation'',''session_title'')');
 FOREACH signature IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
 definition:=pg_get_functiondef(signature::regprocedure);
 IF strpos(definition,'n->>''kind''=''message_annotation''')=0 THEN RAISE EXCEPTION 'conversation_title_validator_predecessor_changed';END IF;
 EXECUTE replace(definition,'n->>''kind''=''message_annotation''','n->>''kind'' IN(''message_annotation'',''session_title'')');
 END LOOP;
END $title_event_owner$;

-- Retired title comparators contribute their authenticated leaf records to the
-- existing registry, never a parallel title registry or runtime availability route.
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN conversation_authenticated a ON a.oid=p.oid
 WHERE p.oid IN(SELECT to_regprocedure('public.'||member)::oid
  FROM jsonb_array_elements('[{"signature":"capture_native_session_projection_batch(uuid,uuid,integer,text)","body":"d9a96c70db2140a15f97e81955bbb295ee6f35fa9059d39e958d4af0a04dcf78","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])","application_current_field_snapshot(uuid,uuid)","application_materialize_field_envelope(uuid,jsonb,integer)","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)","read_native_session_field_snapshots(uuid,uuid[],text[])","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)"],"bodyPinHashes":{"observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])":"e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5","application_current_field_snapshot(uuid,uuid)":"06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403","application_materialize_field_envelope(uuid,jsonb,integer)":"6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5","application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)":"70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72","read_native_session_field_snapshots(uuid,uuid[],text[])":"50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c","application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)":"50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7"}},{"signature":"scope_source_ancestors(uuid,text,uuid)","body":"cabe0f65f8e31b0123ebe2328d72f314ee1b82795cfa5cf66deb57c792384282","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_external_source_dependencies(uuid,text[],uuid[],text[])","body":"49d22c1cfdb98f6eb0d4421a8c080bebc55b3d843f234d0805968366db4186a2","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_external_source_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_scope_source(uuid,text,uuid)","body":"964be13e8633f714a9df7828421c0d6b1dde0aaff78d3da22b08416d9e6d7aa0","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_scope_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","body":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","body":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_query_cohort_nodes(uuid,jsonb)","body":"fb48ece57a33fa8c9f8e73ffd892b835bcf51d72661f355336590fdf026c17c4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_query_cohort_nodes","prorows":1000,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","t"],"proargnames":["w","nodes","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","3802","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","body":"c3de8dda378c2613c0821138a3a9e30b793ff1825ce08d1d73b0ca024d2840de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_cohort_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])"],"bodyPinHashes":{"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])":"decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd"}},{"signature":"read_admitted_native_scope_snapshot(uuid,text,uuid)","body":"9bb8cbfb739df75d85cfd47d5c6662a1c23808c729c599b6f0479f2b0ebb1a0e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","body":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_memory_query_cohort_sources","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","kinds","ids","versions","source"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_entity_derivation_source(uuid,text,uuid)","body":"a5ed483e058aa51e2c0bf67a353c6473df18be66687f541cece0146ce14d26e4","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"native_private_title_frame(uuid,jsonb)","body":"268610786776c1a90c8703878f3ac39bba77c5d3dae0a3ac630e8c4ea6564ad8","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_frame","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","nodes"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_proof(uuid,uuid,uuid)","body":"8bb2a6087aaf9c62aef680356c929a8f73f846239a042d08763505a9dde8b54e","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_proof","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])":"8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)":"2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376"}},{"signature":"private_transcript_message_fingerprint(session_messages)","body":"bb8dd79fc59b9ecd69574df3694ebfd2a089c305e8ce0dd4e26cca740e387976","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_transcript_message_fingerprint","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp","TimeZone=UTC"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["m"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","body":"6718ca009187e650f1db0f81897c35ced0c7f44fe80b9f8b4eed61f3593c7b5b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_frame_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","frame"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"read_native_file_session_field_snapshots(uuid,uuid[],text[])","body":"3a9c531f9216e4ed1099dca7a91006bca2dd0268c5800817aa7daf45aa1e8d37","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"private_legacy_history_binding(sessions)","body":"ede88958a8c91058b31a37cb1fb64c863ee1009027f7afce094f5b38e72a2c21","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"private_legacy_history_binding","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["s"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":false},{"signature":"read_private_transcript_source(uuid,uuid)","body":"0ea4bea3329e6b665a92e25e2077eebb911ea7995c2102357da7aa6bfcc959db","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_private_transcript_source","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"application_native_file_capture_helpers_current()","body":"4d6230003dd9276cd99a08150efe3831616f9d973c630a849f0b450f1c6af64b","pins":["capture_native_session_projection_batch(uuid,uuid,integer,text)","application_memory_statement_helpers_current()","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","application_empty_query_helpers_current()","read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)","application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)","read_native_file_session_field_snapshots(uuid,uuid[],text[])"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_file_capture_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"native_private_title_helpers_current()","body":"f88b16a890b99a1f37e01425236d53a4224a1f6d9fb95bea3d97f5184ed938a7","pins":["scope_source_ancestors(uuid,text,uuid)","read_external_source_dependencies(uuid,text[],uuid[],text[])","read_scope_source(uuid,text,uuid)","read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])","application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","read_native_session_query_cohort_nodes(uuid,jsonb)","read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)","read_admitted_native_scope_snapshot(uuid,text,uuid)","read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])","read_entity_derivation_source(uuid,text,uuid)","application_memory_statement_helpers_current()","application_empty_query_helpers_current()","application_native_worklist_helpers_current()","private_legacy_history_binding(sessions)","private_transcript_message_fingerprint(session_messages)","read_private_transcript_source(uuid,uuid)","native_private_title_frame(uuid,jsonb)","native_private_title_proof(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_private_title_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false},{"signature":"session_context_file_revision_allowed(uuid,uuid)","body":"a36f3c1440dfa1dad87d5005c312ed2da5bf7d3c30e16bc1383c53f53c2e57de","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_file_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_file_revision(uuid,uuid)","body":"334acdc238b0782d7e204515f484e5e06ef6fdb03e59aeddd5ef99256dda369b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_file_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_file_session_title_revision(uuid,uuid,uuid)","body":"1efd74ded55c70183f4ca90bb03cbb356bcc35314961a8d61b88ef18a5a3a735","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_evidence(uuid,text[],uuid[],text[])","body":"632a73985ec9520a5e45a8446e13ff1774f2649e6ab65e49f9a8a43fee96582d","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true},{"signature":"session_context_empty_query_revision_allowed(uuid,uuid)","body":"5deac1df7e9ec71e048008785aa494ec0eb7dd01bba1373e0256016754562f91","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"session_context_empty_query_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["session_context_revision_allowed(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"session_context_revision_allowed(uuid,uuid)":"42a110fb9813834017f41c312fc52cc9e11ba6323adb2e54bab6ad02d210eec4","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_session_context_empty_query_revision(uuid,uuid)","body":"c2663c2d85c3b0dcc168da40b1fc016f9e4837f7efd4412d9a5afbbf15845b72","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_empty_query_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false,"bodyPins":["read_session_context_revision(uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_context_revision(uuid,uuid)":"cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"read_native_empty_query_session_title_revision(uuid,uuid,uuid)","body":"5ba7b7a004054b73d36298a3a7c8384e3fc27f0e6ad5e55ed590af482465925b","pins":[],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":true,"bodyPins":["read_session_title_revision(uuid,uuid,uuid)","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"],"bodyPinHashes":{"read_session_title_revision(uuid,uuid,uuid)":"a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492","read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)":"abbc6a5ae1b87859acb2006aa87a925db67519d859e026c73b3bf51d6883ee6b"}},{"signature":"application_empty_query_facades_current()","body":"121051c87b62aa66642347a6d428951ea02a5cc7bd13af325be0cb0825d11739","pins":["session_context_file_revision_allowed(uuid,uuid)","read_session_context_file_revision(uuid,uuid)","read_native_file_session_title_revision(uuid,uuid,uuid)","application_empty_query_helpers_current()","read_native_empty_query_evidence(uuid,text[],uuid[],text[])","session_context_empty_query_revision_allowed(uuid,uuid)","read_session_context_empty_query_revision(uuid,uuid)","read_native_empty_query_session_title_revision(uuid,uuid,uuid)"],"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_empty_query_facades_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"plpgsql","appExecute":false}]'::jsonb) descriptor
  CROSS JOIN LATERAL jsonb_array_elements_text(descriptor->'pins') member
  WHERE descriptor->>'signature' IN('native_private_title_helpers_current()','application_empty_query_facades_current()'))
 ON CONFLICT DO NOTHING;
DO $canonical_contract_consumers$ DECLARE dependency record;caller record;definition text;canonical oid:='native_turn_helpers_current()'::regprocedure;
BEGIN
 IF (SELECT count(*) FROM conversation_contract_predicates)<>2 THEN RAISE EXCEPTION 'conversation_table_contract_roster';END IF;
 FOR dependency IN SELECT b.*,p.proname FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid
  WHERE b.signature=ANY(ARRAY['application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()',
   'application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()',
   'native_private_title_helpers_current()','application_empty_query_facades_current()']) LOOP
  FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
   AND NOT(p.oid::regprocedure::text=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[])) AND p.oid<>canonical AND p.oid<>'native_retained_helpers_current()'::regprocedure
   AND(p.prosrc~('(^|[^[:alnum:]_])'||dependency.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,dependency.fingerprint)>0) LOOP
   IF NOT EXISTS(SELECT 1 FROM conversation_before b WHERE b.oid=caller.oid)
   THEN RAISE EXCEPTION 'conversation_unreviewed_contract_consumer: %',caller.oid::regprocedure;END IF;
   definition:=pg_get_functiondef(caller.oid);
   definition:=replace(definition,dependency.proname,'native_turn_helpers_current');
   definition:=replace(definition,dependency.fingerprint,'__CANONICAL_GUARD_FINGERPRINT__');
   definition:=replace(definition,dependency.oid::text||'::oid',canonical::text||'::oid');
   EXECUTE definition;
  END LOOP;
 END LOOP;
END $canonical_contract_consumers$;
DO $capture_dependencies$ DECLARE expected jsonb;actual pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"recording_source_read_allowed(uuid,text,uuid)","body":"8a584e976f5e93fa624fc4e5442a5e62f7cd8efb90317f85d7168d03b1b6bcc1","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_source_read_allowed","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"language":"sql","appExecute":true},{"signature":"application_scope_source_edges(uuid,text,uuid,text)","body":"eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077","language":"plpgsql","appExecute":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_source_edges","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}}]'::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR strpos((SELECT prosrc FROM pg_proc WHERE oid='native_turn_compact_metadata(uuid,jsonb,jsonb)'::regprocedure),quote_literal(expected->>'body'))=0
   OR (SELECT count(*)<>CASE WHEN (expected->>'appExecute')::boolean THEN 2 ELSE 1 END OR bool_or(a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND (NOT (expected->>'appExecute')::boolean OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='app_user')))
    FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a)
  THEN RAISE EXCEPTION 'conversation_capture_dependency_changed: %',expected->>'signature';END IF;
  INSERT INTO native_turn_contract_helpers(signature,fingerprint) VALUES(expected->>'signature',encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 END LOOP;
END $capture_dependencies$;
DO $conversation_media_contract$ DECLARE expected jsonb;dependency pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements('[{"signature":"file_session_binding_allows(uuid)","sha":"fa4464861d50f6e69a373116ba0fdcd8f14cd5e6a560e53e66c361dcc43ff9b2","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"file_session_binding_allows","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["file"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"media_parent_visible(text,uuid)","sha":"f762cd69224250421fa84d79be8038f30f5f9be49a505441eb08154ec7843ffd","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"media_parent_visible","prorows":0,"pronargs":2,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["k","i"],"proargtypes":["25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"office_output_file_allows(uuid,boolean)","sha":"5cc29b73c824cc701bba52cd60117eb95b4394f13c35d792d6f59b9cb032d02a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"office_output_file_allows","prorows":0,"pronargs":2,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["f","mutation"],"proargtypes":["2950","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"pdf_intake_file_visible(uuid)","sha":"4f91dad02ed9d3aa16b89f39c1900025a0119868fab21988fab526c132fb0672","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"pdf_intake_file_visible","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["file"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"recording_transcript_file_allows(uuid)","sha":"29a942d9be233ed71004e733b19077d8f3ff7799774dd6363f309c5c62e5d37c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_transcript_file_allows","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["i"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}}]'::jsonb) LOOP
  SELECT * INTO STRICT dependency FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF encode(sha256(convert_to(dependency.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'sha'
   OR (to_jsonb(dependency)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM expected->'metadata'
   OR dependency.proowner<>owner_id OR dependency.pronamespace<>'public'::regnamespace
   OR dependency.prolang<>(SELECT oid FROM pg_language WHERE lanname=CASE WHEN expected#>>'{metadata,proname}'='media_parent_visible' THEN 'plpgsql' ELSE 'sql' END)
   OR dependency.proargdefaults IS NOT NULL
   OR (SELECT count(*) IN(2,3) AND count(DISTINCT a.grantee)=count(*)
     AND coalesce(bool_and(a.grantor=dependency.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable
      AND a.grantee IN(0::oid,dependency.proowner,to_regrole('app_user')::oid)),false)
     AND coalesce(bool_or(a.grantee=dependency.proowner),false) AND coalesce(bool_or(a.grantee=0),false)
    FROM aclexplode(coalesce(dependency.proacl,acldefault('f',dependency.proowner))) a) IS NOT TRUE
  THEN RAISE EXCEPTION 'native_media_admission_dependency_changed: %',expected->>'signature';END IF;

 INSERT INTO native_turn_contract_helpers(signature,fingerprint) VALUES(expected->>'signature',encode(sha256(convert_to(to_jsonb(dependency)::text,'UTF8')),'hex'));
 END LOOP;
END $conversation_media_contract$;
-- The successor is installed from this template, never adopted from catalog code.
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p WHERE oid=ANY(ARRAY['read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure::oid,
  'capture_conversation_query(uuid,uuid,integer,integer)'::regprocedure::oid,
  'capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure::oid,
  'conversation_prepare_publications(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_source_edges(uuid,text,uuid,text)'::regprocedure::oid,
  'conversation_capture_privacy(uuid,jsonb)'::regprocedure::oid,
  'conversation_recording_scope(uuid,jsonb)'::regprocedure::oid,
  'conversation_message_snapshot(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_revision_snapshot(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_dag(uuid,jsonb,jsonb)'::regprocedure::oid,
  'conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_edges(uuid,jsonb)'::regprocedure::oid,
  'conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_scope(uuid,text,uuid,text,jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)'::regprocedure::oid,
  'read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)'::regprocedure::oid,
  'read_session_department_facts(uuid,uuid,uuid)'::regprocedure::oid]);
DO $query_rosters$ DECLARE signature text;definition text;old_array text;new_array text;start_at integer;end_at integer;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_retained_helpers_current()'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(signature));
  start_at:=strpos(definition,'array_agg(h.signature ORDER BY h.signature)=')+length('array_agg(h.signature ORDER BY h.signature)=');
  end_at:=strpos(substring(definition FROM start_at),'::text[]')+start_at-1;
  IF start_at<=length('array_agg(h.signature ORDER BY h.signature)=') OR end_at<start_at THEN RAISE EXCEPTION 'conversation_reader_roster_shape';END IF;
  old_array:=substring(definition FROM start_at FOR end_at-start_at);
  IF signature='native_turn_helpers_current()' THEN
   DELETE FROM native_turn_contract_helpers h WHERE h.signature=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[]);
   SELECT 'ARRAY['||string_agg(quote_literal(h.signature),',' ORDER BY h.signature)||']' INTO new_array FROM native_turn_contract_helpers h;
  ELSE
   DELETE FROM native_retained_contract_helpers h WHERE h.signature=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[]);
   SELECT 'ARRAY['||string_agg(quote_literal(h.signature),',' ORDER BY h.signature)||']' INTO new_array FROM native_retained_contract_helpers h;
  END IF;
  EXECUTE replace(definition,old_array,new_array);
 END LOOP;
END $query_rosters$;
-- Replace repeated catalog serialization/hashing with complete native record
-- comparison. Keep the predecessor hashes only until reviewed pin propagation
-- finishes, then remove that column before validating the installed successor.
ALTER TABLE native_turn_contract_helpers ADD COLUMN contract pg_catalog.pg_proc;
DO $contract_records$ DECLARE definition text;catalog_shape jsonb;old_clause text:='h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')';old_join text:='p.oid=to_regprocedure(h.signature)';BEGIN
 definition:=pg_get_functiondef('native_turn_helpers_current()'::regprocedure);
 IF strpos(definition,old_clause)=0 OR strpos(definition,old_join)=0 OR strpos(definition,'ARRAY[''signature'',''fingerprint'']')=0 THEN RAISE EXCEPTION 'conversation_contract_predecessor_changed';END IF;
 SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) INTO catalog_shape
 FROM pg_attribute WHERE attrelid='pg_catalog.pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 definition:=replace(definition,'SELECT EXISTS(SELECT 1 FROM pg_class relation',
  'SELECT (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS NOT DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb AND EXISTS(SELECT 1 FROM pg_class relation');
 EXECUTE replace(replace(replace(definition,old_join,'p.oid=(h.contract).oid'),old_clause,'p IS NOT DISTINCT FROM h.contract'),'ARRAY[''signature'',''fingerprint'']','ARRAY[''signature'',''contract'']');
END $contract_records$;
DO $canonical_contract_tables$ DECLARE definition text;predicates text;BEGIN
 -- Only the surviving source FK and trigger contracts remain. The former
 -- queue state and its repeated predicates have no runtime owner.
 IF (SELECT count(DISTINCT predicate) FROM conversation_contract_predicates)<>2
 THEN RAISE EXCEPTION 'conversation_distinct_table_contract_roster';END IF;
 SELECT string_agg('('||predicate||')',' AND ' ORDER BY predicate) INTO predicates
 FROM (SELECT DISTINCT predicate FROM conversation_contract_predicates) contracts;
 definition:=pg_get_functiondef('native_turn_helpers_current()'::regprocedure);
 IF strpos(definition,'SELECT native_turn_publication_contract() AND ')=0 THEN RAISE EXCEPTION 'conversation_contract_owner_shape';END IF;
 EXECUTE replace(definition,'SELECT native_turn_publication_contract() AND ','SELECT native_turn_publication_contract() AND ('||predicates||') AND ');
END $canonical_contract_tables$;
DO $canonical_contract_pins$ DECLARE pin text;caller record;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure;
 FOR caller IN SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p
  JOIN conversation_before b ON b.oid=p.oid WHERE strpos(p.prosrc,'__CANONICAL_GUARD_FINGERPRINT__')>0 LOOP
  EXECUTE replace(caller.definition,'__CANONICAL_GUARD_FINGERPRINT__',pin);
 END LOOP;
END $canonical_contract_pins$;
DO $capture_guard$ DECLARE definition text;pin text;signature text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure;
 FOREACH signature IN ARRAY ARRAY['capture_conversation_query(uuid,uuid,integer,integer)','capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'] LOOP
 definition:=pg_get_functiondef(to_regprocedure(signature));
 EXECUTE replace(definition,'__CAPTURE_GUARD_FINGERPRINT__',pin);END LOOP;
 UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p
 WHERE h.signature IN('capture_conversation_query(uuid,uuid,integer,integer)','capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)') AND p.oid=to_regprocedure(h.signature);
END $capture_guard$;

DO $capture$ DECLARE definition text;old_clause text:=' OR EXISTS(SELECT 1 FROM native_turn_publication_seals seal WHERE seal.transaction_id=txid_current() AND seal.frame_id=selected_frame)';
BEGIN
 definition:=pg_get_functiondef('native_turn_capture_event(jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'conversation_capture_predecessor_changed';END IF;
 -- All rows of one compound write are visible to its AFTER triggers. The
 -- existing completion debt still requires every exact event to be discharged.
 EXECUTE replace(definition,old_clause,'');
END $capture$;
-- Executable/table contracts belong to the physical writer and independent
-- completion, not each event. These are authenticated private callees; their
-- original context, source, seal, debt and exact event predicates remain.
DO $publication_contract_owner$ DECLARE signature text;definition text;pin text;predicate text;old_fragment text;new_fragment text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_publication_contract()'::regprocedure;
 predicate:='(SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'') FROM pg_proc p WHERE p.oid=''native_turn_publication_contract()''::regprocedure) IS DISTINCT FROM '||quote_literal(pin);
 FOREACH signature IN ARRAY ARRAY['native_turn_capture_event(jsonb)','native_turn_field_reference(uuid,uuid,uuid,text)',
  'native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)','native_turn_guard_completion_debt()'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF signature='native_turn_capture_event(jsonb)' THEN
   old_fragment:=' IF '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;';
   new_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;';
  ELSIF signature='native_turn_page_event(jsonb)' THEN
   old_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;
 IF native_turn_publication_contract() IS NOT TRUE OR ';
   new_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;
 IF ';
  ELSIF signature='native_turn_guard_completion_debt()' THEN
   old_fragment:='  OR '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE OR native_turn_helpers_current() IS NOT TRUE';
   new_fragment:='  OR '||predicate||' OR native_turn_helpers_current() IS NOT TRUE';
  ELSE
   old_fragment:=' IF '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE OR ';
   new_fragment:=' IF '||predicate||' OR ';
  END IF;
  IF strpos(definition,old_fragment)=0 THEN RAISE EXCEPTION 'conversation_event_contract_shape: %',signature;END IF;
  definition:=replace(definition,old_fragment,new_fragment);
  IF strpos(definition,'native_turn_publication_contract() IS NOT TRUE')>0 THEN RAISE EXCEPTION 'conversation_event_contract_remaining: %',signature;END IF;
  EXECUTE definition;
 END LOOP;
END $publication_contract_owner$;

DO $construction_errors$ DECLARE routine text;definition text;
BEGIN
 FOREACH routine IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(routine));
  IF strpos(definition,'native_turn_construction_unavailable')=0 THEN RAISE EXCEPTION 'conversation_error_predecessor_changed';END IF;
  EXECUTE replace(replace(definition,'native_turn_construction_unavailable','scope_source_changed'),quote_literal('PNT02'),quote_literal('42501'));
 END LOOP;
END $construction_errors$;
DO $contract$ DECLARE before_row jsonb;after_row jsonb;definition text;expected jsonb;old_literal text;start_at integer;end_at integer;relation regclass;keys text[];capture jsonb;
BEGIN
 SELECT metadata INTO STRICT before_row FROM conversation_constraint_before;
 SELECT to_jsonb(c) INTO STRICT after_row FROM pg_constraint c WHERE conrelid='native_turn_frames'::regclass AND conname='native_turn_frames_format_check';
 definition:=pg_get_functiondef('native_turn_publication_contract()'::regprocedure);
 start_at:=strpos(definition,'IS NOT DISTINCT FROM ')+length('IS NOT DISTINCT FROM ');
 end_at:=strpos(definition,'::jsonb) AND');
 old_literal:=substring(definition FROM start_at FOR end_at-start_at);
 EXECUTE 'SELECT '||old_literal||'::jsonb' INTO expected;
 IF NOT(expected->'constraints') @> jsonb_build_array(before_row) THEN RAISE EXCEPTION 'conversation_constraint_predecessor_changed';END IF;
 expected:=jsonb_set(expected,'{constraints}',(SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) FROM (
  SELECT CASE WHEN value=before_row THEN after_row ELSE value END value FROM jsonb_array_elements(expected->'constraints')) changed));
 expected:=jsonb_set(expected,'{columns}',(SELECT jsonb_agg(value ORDER BY (value->>0)::oid,(value->>1)::integer) FROM (
  SELECT value FROM jsonb_array_elements(expected->'columns')
  UNION ALL SELECT jsonb_build_array(attrelid,attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl)
   FROM pg_attribute WHERE attrelid='native_turn_publication_work'::regclass AND attname='completion_owner' AND atttypid='uuid'::regtype AND NOT attnotnull AND NOT attisdropped AND attacl IS NULL
 ) changed));
 -- Recovery executable ownership was transferred with the authenticated flat
 -- dependency registry. Do not create a second source of executable contracts.
 IF NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
  WHERE h.signature='crm_capture_erasure_effect()' AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'conversation_recovery_capture_untrusted';END IF;
 -- These six relations are already covered by the authenticated predecessor
 -- contract. Add only the reviewed recovery trigger, preserving every old row.
 FOREACH relation IN ARRAY ARRAY['native_turn_frames'::regclass,'native_turn_publication_work'::regclass,
  'native_turn_publication_events'::regclass,'native_turn_publication_seals'::regclass,
  'native_turn_publication_impossible'::regclass,'native_turn_publication_debt'::regclass] LOOP
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation AND tgname='crm_recovery_capture')
   THEN RAISE EXCEPTION 'conversation_unexpected_recovery_capture';END IF;
  SELECT array_agg(a.attname::text ORDER BY k.ord) INTO keys FROM pg_constraint p,
   unnest(p.conkey) WITH ORDINALITY k(id,ord),pg_attribute a
   WHERE p.conrelid=relation AND p.contype='p' AND a.attrelid=relation AND a.attnum=k.id;
  INSERT INTO crm_erasure_journal_targets(table_name,key_columns,capture_inserts)
   SELECT relname,coalesce(keys,'{}'),false FROM pg_class WHERE oid=relation
   ON CONFLICT(table_name) DO UPDATE SET key_columns=EXCLUDED.key_columns,capture_inserts=EXCLUDED.capture_inserts;
  EXECUTE format('CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()',relation);
  SELECT to_jsonb(t) INTO STRICT capture FROM pg_trigger t WHERE tgrelid=relation AND tgname='crm_recovery_capture';
  expected:=jsonb_set(expected,'{triggers}',(SELECT jsonb_agg(t ORDER BY (t->>'oid')::oid)
   FROM jsonb_array_elements((expected->'triggers')||jsonb_build_array(capture)) t));
 END LOOP;
 EXECUTE replace(definition,old_literal,quote_literal(expected::text));
END $contract$;
DO $pins$ DECLARE changed record;caller record;iterations integer:=0;ok boolean;signature text;guard_body text;guard_comparison text;guard_rows text;guard_detail text;flat record;row_sql text;rows_sql text;replacement text;
BEGIN
 LOOP
  SELECT b.oid,b.fingerprint,b.metadata->>'prosrc' old_body,p.prosrc current_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_hash INTO changed
   FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid
   WHERE b.fingerprint<>encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') ORDER BY b.signature LIMIT 1;
  EXIT WHEN NOT FOUND;
  iterations:=iterations+1;IF iterations>100 THEN RAISE EXCEPTION 'conversation_pin_cycle';END IF;
  FOR caller IN SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND strpos(p.prosrc,changed.fingerprint)>0
    AND NOT(p.oid::regprocedure::text=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[])) LOOP
   IF NOT EXISTS(SELECT 1 FROM conversation_before b WHERE b.oid=caller.oid) THEN
    RAISE EXCEPTION 'conversation_unreviewed_pin_consumer: %',caller.oid::regprocedure;END IF;
   EXECUTE replace(caller.definition,changed.fingerprint,changed.current_hash);
  END LOOP;
  UPDATE native_turn_contract_helpers SET fingerprint=changed.current_hash WHERE fingerprint=changed.fingerprint;
  UPDATE native_retained_contract_helpers SET fingerprint=changed.current_hash WHERE fingerprint=changed.fingerprint;
  UPDATE conversation_before SET fingerprint=changed.current_hash,metadata=jsonb_set(metadata,'{prosrc}',to_jsonb(changed.current_body)) WHERE oid=changed.oid;
 END LOOP;
 UPDATE native_turn_contract_helpers h SET contract=p FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature);
 ALTER TABLE native_turn_contract_helpers ALTER COLUMN contract SET NOT NULL;
 ALTER TABLE native_turn_contract_helpers DROP COLUMN fingerprint;
 IF EXISTS(SELECT 1 FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid WHERE (to_jsonb(p)-'prosrc') IS DISTINCT FROM(b.metadata-'prosrc')) THEN
  RAISE EXCEPTION 'conversation_successor_metadata_changed';END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_retained_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN
   SELECT prosrc INTO guard_body FROM pg_proc WHERE oid=to_regprocedure(signature);
   IF strpos(guard_body,'coalesce(bool_and(')>0 AND strpos(guard_body,') m(oid,')>0 THEN
    guard_comparison:=split_part(split_part(guard_body,'coalesce(bool_and(',2),'),false) FROM (VALUES ',1);
    guard_rows:=substring(guard_body FROM strpos(guard_body,'FROM (VALUES '));
    guard_rows:=left(guard_rows,length(guard_rows)-strpos(reverse(guard_rows),reverse(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid'))+1);
    EXECUTE 'SELECT string_agg(p.oid::regprocedure::text,'','') '||guard_rows||' WHERE NOT('||guard_comparison||')' INTO guard_detail;
   END IF;
   RAISE EXCEPTION 'conversation_successor_contract_changed: %',signature USING DETAIL=coalesce(guard_detail,'non-function contract');
  END IF;
 END LOOP;
END $pins$;
DO $retire$ DECLARE routine text;target pg_proc;BEGIN
 FOREACH routine IN ARRAY ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[] LOOP
  SELECT * INTO STRICT target FROM pg_proc WHERE oid=to_regprocedure('public.'||routine);
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.oid<>target.oid
   AND NOT(p.oid::regprocedure::text=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[]))
   AND(p.prosrc~('(^|[^[:alnum:]_])'||target.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,target.oid::text||'::oid')>0)) THEN
   RAISE EXCEPTION 'conversation_retirement_has_consumer: %',routine USING DETAIL=(SELECT string_agg(p.oid::regprocedure::text,',') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.oid<>target.oid
   AND NOT(p.oid::regprocedure::text=ANY(ARRAY['native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)','native_private_title_helpers_current()','read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed(uuid,uuid)','application_empty_query_facades_current()','enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','application_native_transcript_prepare_helpers_current()','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','native_retained_graph_append(jsonb,jsonb,boolean)','native_retained_graph_edges(jsonb,boolean)','native_retained_graph_equal(jsonb,jsonb,boolean)','native_retained_graph_seed(jsonb,boolean)','native_retained_graph_topology(jsonb)','native_retained_node_key(jsonb,boolean)','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])','native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_plan(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)','native_retained_edge_rows(uuid,jsonb[],integer[],boolean)','native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)','native_retained_graph_closure(uuid,jsonb,boolean)','native_retained_graph_overlay(jsonb,jsonb,boolean)','native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)','native_retained_metadata(uuid,jsonb,jsonb,boolean)','native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_turn_requirements(uuid,jsonb)','read_native_retained_requirements(uuid,jsonb,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)','read_native_retained_session_query(uuid,uuid,integer,integer)','read_native_session_query_evidence(uuid,uuid,integer,integer)','application_native_session_query_acquisition_current()','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_topics(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)']::text[]))
   AND(p.prosrc~('(^|[^[:alnum:]_])'||target.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex'))>0 OR strpos(p.prosrc,target.oid::text||'::oid')>0));END IF;
  EXECUTE 'DROP FUNCTION public.'||routine||' RESTRICT';
 END LOOP;
END $retire$;
DROP TABLE public.native_field_dependency_work RESTRICT;
DROP TABLE public.native_field_dependency_batches RESTRICT;
DO $promotion_integrity$ DECLARE routine pg_proc;BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='public.guard_episodic_promotion()'::regprocedure;
 IF routine.prosrc IS DISTINCT FROM '
BEGIN
 IF TG_OP=''UPDATE'' AND OLD.promoted_memory_id IS NOT NULL THEN
  IF NEW.promoted_memory_id IS DISTINCT FROM OLD.promoted_memory_id THEN
   RAISE EXCEPTION ''episodic_promotion_immutable'';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.promoted_memory_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.scope_revision_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM session_context_scope_revisions r
   JOIN memories m ON m.workspace_id=r.workspace_id AND m.id=NEW.promoted_memory_id
   JOIN scope_derivations d ON d.workspace_id=m.workspace_id AND d.resource_kind=''memory''
    AND d.resource_id=m.id AND d.resource_version=m.scope_version::text
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
    AND s.source_kind=''session_context_revision'' AND s.source_id=r.id AND s.source_version=r.scope_version::text
   WHERE r.id=NEW.scope_revision_id AND r.parent_kind=''episodic_memory''
    AND r.parent_id=NEW.id AND r.session_id=NEW.session_id AND m.valid_to IS NULL
 ) THEN RAISE EXCEPTION ''episodic_promotion_requires_derivation''; END IF;
 RETURN NEW;
END ' OR routine.prosecdef
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='episodic_memories'::regclass)
  OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
 THEN RAISE EXCEPTION 'conversation_promotion_predecessor_changed';END IF;
 ALTER FUNCTION public.guard_episodic_promotion() SECURITY DEFINER;
END $promotion_integrity$;
DO $episode_policy$ BEGIN
 IF (SELECT jsonb_agg(jsonb_build_object('polname',polname,'polcmd',polcmd,'polpermissive',polpermissive,'polroles',polroles::integer[],
  'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) ORDER BY polname)
  FROM pg_policy WHERE polrelid='episodic_memories'::regclass AND polname IN('episodic_memories_own','episodic_revision_floor'))
  IS DISTINCT FROM '[{"polname":"episodic_memories_own","polcmd":"*","polpermissive":true,"polroles":[0],"using":"(user_id = (current_setting(''app.current_user_id''::text, true))::uuid)","check":null},{"polname":"episodic_revision_floor","polcmd":"r","polpermissive":false,"polroles":[0],"using":"((scope_revision_id IS NOT NULL) AND session_context_revision_allowed(( SELECT sessions.workspace_id\n   FROM sessions\n  WHERE (sessions.id = episodic_memories.session_id)), scope_revision_id))","check":null}]'::jsonb
 THEN RAISE EXCEPTION 'conversation_episode_policy_predecessor_changed';END IF;
END $episode_policy$;
-- Parent housekeeping consumes the same exact source authority as its reader.
-- A historical creator ID cannot substitute for, or veto, current admission.
DROP POLICY episodic_memories_own ON episodic_memories;
DROP POLICY episodic_revision_floor ON episodic_memories;
CREATE POLICY episodic_context_authority ON episodic_memories
 USING(scope_revision_id IS NOT NULL AND session_recording_read_allowed(session_id) AND EXISTS(
  SELECT 1 FROM sessions s WHERE s.id=episodic_memories.session_id
   AND session_context_revision_allowed(s.workspace_id,episodic_memories.scope_revision_id)))
 WITH CHECK(scope_revision_id IS NOT NULL AND session_recording_read_allowed(session_id) AND EXISTS(
  SELECT 1 FROM sessions s WHERE s.id=episodic_memories.session_id
   AND session_context_revision_allowed(s.workspace_id,episodic_memories.scope_revision_id)));

COMMIT;
