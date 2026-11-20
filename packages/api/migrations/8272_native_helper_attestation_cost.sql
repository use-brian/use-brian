-- [COMP:api/native-chat-read-cost] Lossless native pg_proc attestation.
-- No authority result is cached. Compare fresh source bytes and ALL fresh
-- metadata on every call; the historical full-row fingerprints stay authoritative.
-- In UTF8, bytea's immutable escape input preserves canonical JSON text bytes
-- after doubling every backslash. convert_to/textsend are STABLE, so neither
-- belongs in a generated column or a falsely IMMUTABLE encoding wrapper.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $attestation_preflight$
DECLARE actual pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 declared_native_members constant text[]:=ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_field_digest(jsonb)','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_query_context(uuid)','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','assistant_placement_visible(uuid,uuid)','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_publication_cohorts(uuid,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_scope_source(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','scope_review_state_held(text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','sensitivity_rank(text)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[];
 declared_roster text;ok boolean;signature text;
BEGIN
 IF current_setting('server_encoding')<>'UTF8' OR current_setting('server_version_num')::integer/10000<>18
 THEN RAISE EXCEPTION 'native_helper_attestation_catalog_version';END IF;
 IF (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
  WHERE attrelid='pg_catalog.pg_proc'::regclass AND attnum>0) IS DISTINCT FROM ARRAY['oid','proname','pronamespace','proowner','prolang','procost','prorows','provariadic','prosupport','prokind','prosecdef','proleakproof','proisstrict','proretset','provolatile','proparallel','pronargs','pronargdefaults','prorettype','proargtypes','proallargtypes','proargmodes','proargnames','proargdefaults','protrftypes','prosrc','probin','prosqlbody','proconfig','proacl']::text[]
 THEN RAISE EXCEPTION 'native_helper_attestation_catalog_columns';END IF;
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_turn_helpers_current()'::regprocedure;
 SELECT 'ARRAY['||string_agg(quote_literal(member),',' ORDER BY member)||']::text[]' INTO declared_roster
 FROM unnest(declared_native_members) member;
 IF (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM '{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
 OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
 OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
 OR (length(actual.prosrc)-length(replace(actual.prosrc,declared_roster,'')))/length(declared_roster)<>1
 OR encode(sha256(convert_to(replace(actual.prosrc,declared_roster,'__ROSTER__'),'UTF8')),'hex')<>'803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
  WHERE a.grantee<>owner_id OR a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'native_helper_attestation_predecessor_root';END IF;
 -- Authenticate publication metadata as well as its reconstructed source.
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_turn_publication_contract()'::regprocedure;
 IF (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM '{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_publication_contract","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
 OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
 OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
  WHERE a.grantee<>owner_id OR a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'native_helper_attestation_predecessor_publication';END IF;
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

 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'native_retained_helpers_current()','application_native_worklist_helpers_current()',
  'application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()',
  'application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_helper_attestation_predecessor_contract: %',signature;END IF;
 END LOOP;
END $attestation_preflight$;
-- Fixed extra comparators plus the complete, fixed native cohort authenticated
-- above. Discovery of a textual pin NEVER enrolls its consumer.
CREATE TEMP TABLE attestation_manifest(oid oid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO attestation_manifest SELECT unnest(ARRAY[
  'native_turn_helpers_current()'::regprocedure,
  'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure,
  'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure,
  'application_native_field_reference_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure,
  'application_native_covered_evidence_helpers_current()'::regprocedure,
  'application_native_dependency_batch_helpers_current()'::regprocedure,
  'application_empty_query_facades_current()'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,
  'application_native_covered_queue_current()'::regprocedure,'application_native_context_fields_current()'::regprocedure,
  'application_native_session_query_acquisition_current()'::regprocedure,'application_native_title_acquisition_helpers_current()'::regprocedure,
  'application_native_title_group_helpers_current()'::regprocedure,'application_native_transcript_prepare_helpers_current()'::regprocedure,
  'application_native_file_capture_helpers_current()'::regprocedure,'application_native_worklist_helpers_current()'::regprocedure,
  'native_private_title_helpers_current()'::regprocedure,'native_retained_helpers_current()'::regprocedure,
  'read_native_private_title_evidence(uuid,uuid)'::regprocedure,'read_native_private_title_acquisition(uuid,uuid,uuid)'::regprocedure,
  'capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)'::regprocedure,
  'native_retained_capture_cohorts(uuid,jsonb,jsonb)'::regprocedure,'native_retained_capture_requirements(uuid,jsonb,jsonb)'::regprocedure,
  'native_turn_capture_event(jsonb)'::regprocedure,'native_turn_field_reference(uuid,uuid,uuid,text)'::regprocedure,
  'native_turn_guard_completion_debt()'::regprocedure,'native_turn_page_event(jsonb)'::regprocedure,
  'native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)'::regprocedure,'native_turn_publication_contract()'::regprocedure,
  'native_turn_validate_event(jsonb)'::regprocedure,'prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure,
  'publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'::regprocedure,
  'read_native_covered_session_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'read_native_personal_title_group_evidence(uuid,uuid[],uuid[])'::regprocedure,
  'read_native_retained_publication_cohorts(uuid,jsonb)'::regprocedure,'read_native_retained_requirements(uuid,jsonb,jsonb)'::regprocedure,
  'read_native_retained_scope_evidence(uuid,jsonb)'::regprocedure,'read_native_retained_session_query(uuid,uuid,integer,integer)'::regprocedure,
  'read_native_session_query_evidence(uuid,uuid,integer,integer)'::regprocedure,'read_native_turn_requirements(uuid,jsonb)'::regprocedure,
  'validate_application_field_dependencies()'::regprocedure,
  'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,'read_session_context_file_revision(uuid,uuid)'::regprocedure,
  'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,'session_context_file_revision_allowed(uuid,uuid)'::regprocedure]::oid[]);
DO $$ BEGIN
 IF (SELECT count(*) FROM attestation_manifest)<>50 THEN RAISE EXCEPTION 'native_helper_attestation_manifest_missing';END IF;
END $$;
INSERT INTO attestation_manifest SELECT to_regprocedure('public.'||signature)::oid
 FROM public.native_turn_contract_helpers ON CONFLICT DO NOTHING;
CREATE TEMP TABLE attestation_predecessors ON COMMIT DROP AS
 SELECT p.oid,to_jsonb(p)-'prosrc' AS metadata,p.prosrc AS original,p.prosrc AS expected,
  encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash,
  p.prosrc AS pinned_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS pinned_fingerprint,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS pinned_body_hash
 FROM pg_proc p JOIN attestation_manifest m ON m.oid=p.oid;

CREATE TEMP TABLE attestation_catalog(routine pg_proc) ON COMMIT DROP;
INSERT INTO attestation_catalog SELECT p FROM pg_proc p JOIN attestation_predecessors m ON m.oid=p.oid;

CREATE TABLE public.native_turn_helper_attestations(
 signature text PRIMARY KEY,
 expected_text text NOT NULL,
 original_fingerprint text GENERATED ALWAYS AS (encode(sha256(replace(expected_text,chr(92),chr(92)||chr(92))::bytea),'hex')) STORED NOT NULL,
 expected_body text GENERATED ALWAYS AS ((expected_text::jsonb)->>'prosrc') STORED NOT NULL,
 expected_metadata jsonb GENERATED ALWAYS AS ((expected_text::jsonb)-'prosrc') STORED NOT NULL
);
ALTER TABLE public.native_turn_helper_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_turn_helper_attestations FROM PUBLIC,app_user;
DO $attestation_install$
DECLARE body text;old_body text;table_shape jsonb;catalog_shape jsonb;relation_id oid:='public.native_turn_helper_attestations'::regclass;
BEGIN
 SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl,attcollation,atthasdef) ORDER BY attnum) FROM pg_attribute WHERE attrelid=relation_id AND attnum>0),
 'defaults',(SELECT jsonb_agg(jsonb_build_array(adnum,adbin::text) ORDER BY adnum) FROM pg_attrdef WHERE adrelid=relation_id),
 'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k WHERE conrelid=relation_id),
 'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i WHERE indrelid=relation_id)) INTO table_shape;
 SELECT (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attisdropped) ORDER BY attnum) FROM pg_attribute WHERE attrelid='pg_catalog.pg_proc'::regclass AND attnum>0) INTO catalog_shape;
 SELECT original INTO STRICT old_body FROM attestation_predecessors WHERE oid='public.native_turn_helpers_current()'::regprocedure;
 -- The preceding root template validation authorizes exactly this one substitution.
 body:=replace(old_body,
  'bool_and(p.oid IS NOT NULL AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex''))',
  'true');
 IF body=old_body THEN RAISE EXCEPTION 'native_helper_attestation_substitution_missing';END IF;
 body:='SELECT ('||body||') AND ('||replace(replace(replace(replace($fast_body$ SELECT EXISTS(SELECT 1 FROM pg_class r WHERE r.oid='public.native_turn_helper_attestations'::regclass
 AND r.oid=__RELATION_ID__ AND r.relnamespace='public'::regnamespace
 AND r.relowner=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
 AND r.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
 AND r.relkind='r' AND r.relpersistence='p' AND r.relrowsecurity AND NOT r.relforcerowsecurity
 AND NOT r.relispartition AND r.reloptions IS NULL AND r.relam=(SELECT oid FROM pg_am WHERE amname='heap')
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) a
  WHERE a.grantee<>r.relowner OR a.grantor<>r.relowner OR a.is_grantable)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
 AND jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl,attcollation,atthasdef) ORDER BY attnum) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0),
 'defaults',(SELECT jsonb_agg(jsonb_build_array(adnum,adbin::text) ORDER BY adnum) FROM pg_attrdef WHERE adrelid=r.oid),
 'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k WHERE conrelid=r.oid),
 'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i WHERE indrelid=r.oid))=__TABLE_SHAPE__::jsonb)
 AND (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attisdropped) ORDER BY attnum) FROM pg_attribute WHERE attrelid='pg_catalog.pg_proc'::regclass AND attnum>0)=__CATALOG_SHAPE__::jsonb
 AND (SELECT array_agg(h.signature ORDER BY h.signature) FROM public.native_turn_contract_helpers h)=__ROSTER__
 AND (SELECT count(*)=count(DISTINCT signature) FROM public.native_turn_helper_attestations)
 AND NOT EXISTS(SELECT 1 FROM public.native_turn_helper_attestations c FULL JOIN public.native_turn_contract_helpers h USING(signature)
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)
 WHERE c.signature IS NULL OR h.signature IS NULL OR p.oid IS NULL
 OR c.original_fingerprint IS DISTINCT FROM h.fingerprint
 OR p.prosrc IS DISTINCT FROM c.expected_body
 OR jsonb_build_object('oid',p.oid,'proname',p.proname,'pronamespace',p.pronamespace,'proowner',p.proowner,'prolang',p.prolang,'procost',p.procost,'prorows',p.prorows,'provariadic',p.provariadic,'prosupport',p.prosupport,'prokind',p.prokind,'prosecdef',p.prosecdef,'proleakproof',p.proleakproof,'proisstrict',p.proisstrict,'proretset',p.proretset,'provolatile',p.provolatile,'proparallel',p.proparallel,'pronargs',p.pronargs,'pronargdefaults',p.pronargdefaults,'prorettype',p.prorettype,'proargtypes',p.proargtypes,'proallargtypes',p.proallargtypes,'proargmodes',p.proargmodes,'proargnames',p.proargnames,'proargdefaults',p.proargdefaults,'protrftypes',p.protrftypes,'probin',p.probin,'prosqlbody',p.prosqlbody,'proconfig',p.proconfig,'proacl',p.proacl) IS DISTINCT FROM c.expected_metadata)
$fast_body$,
  '__RELATION_ID__',relation_id::text),'__TABLE_SHAPE__',quote_literal(table_shape::text)),
  '__CATALOG_SHAPE__',quote_literal(catalog_shape::text)), '__ROSTER__',
  (SELECT 'ARRAY['||string_agg(quote_literal(signature),',' ORDER BY signature)||']::text[]' FROM public.native_turn_contract_helpers))||')';
 EXECUTE replace(pg_get_functiondef('public.native_turn_helpers_current()'::regprocedure),old_body,body);
 UPDATE attestation_predecessors SET expected=body WHERE oid='public.native_turn_helpers_current()'::regprocedure;
END $attestation_install$;
DO $native_helper_attestation_pins$
DECLARE previous record;consumer record;body text;round integer;changed boolean;signature text;ok boolean;
 row_sql text;before_row text;after_row text;reference_body text;reference_current text;failures text[]:='{}';
 reference_oid oid:='application_native_field_reference_helpers_current()'::regprocedure;
BEGIN
 IF ARRAY(SELECT oid FROM attestation_predecessors ORDER BY oid)
  IS DISTINCT FROM ARRAY(SELECT oid FROM attestation_manifest ORDER BY oid)
 THEN RAISE EXCEPTION 'native_helper_attestation_manifest_missing';END IF;
 -- Use the exact existing catalog-row serializer. Original composite rows were
 -- captured before ANY change, so only whole authenticated member rows can be
 -- replaced in the reference comparator. No unauthenticated member is enrolled.
 SELECT string_agg(format('format(%L,%s)', '%L::'||CASE WHEN attname='proacl' THEN 'jsonb'
   WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN 'text' ELSE format_type(atttypid,atttypmod) END,
   CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype)
    THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END),'||'',''||' ORDER BY attnum)
 INTO row_sql FROM pg_attribute WHERE attrelid='pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 FOR round IN 1..64 LOOP
  changed:=false;
  IF EXISTS(SELECT 1 FROM attestation_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
  THEN RAISE EXCEPTION 'native_helper_attestation_metadata_changed';END IF;
  SELECT original INTO STRICT reference_body FROM attestation_predecessors WHERE oid=reference_oid;
  SELECT prosrc INTO STRICT reference_current FROM pg_proc WHERE oid=reference_oid;
  FOR previous IN SELECT m.*,p.prosrc current_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint
   FROM attestation_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.oid<>reference_oid AND m.original IS DISTINCT FROM p.prosrc LOOP
   EXECUTE 'SELECT ''(''||'||row_sql||'||'')'' FROM (SELECT (routine).* FROM attestation_catalog) p WHERE p.oid=$1'
    INTO STRICT before_row USING previous.oid;
   IF position(before_row IN reference_body)>0 THEN
    EXECUTE 'SELECT ''(''||'||row_sql||'||'')'' FROM pg_proc p WHERE p.oid=$1' INTO STRICT after_row USING previous.oid;
    reference_body:=replace(reference_body,before_row,after_row);
   END IF;
  END LOOP;
  IF reference_body IS DISTINCT FROM reference_current THEN
   EXECUTE replace(pg_get_functiondef(reference_oid),reference_current,reference_body);
   UPDATE attestation_predecessors SET expected=reference_body WHERE oid=reference_oid;
   changed:=true;
  END IF;
  IF EXISTS(SELECT 1 FROM attestation_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
  THEN RAISE EXCEPTION 'native_helper_attestation_metadata_changed';END IF;
  FOR previous IN SELECT m.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM attestation_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.pinned_body IS DISTINCT FROM p.prosrc LOOP
   FOR consumer IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid
    AND (position(quote_literal(previous.pinned_body) IN p.prosrc)>0 OR position(previous.pinned_fingerprint IN p.prosrc)>0
     OR position(previous.pinned_body_hash IN p.prosrc)>0) LOOP
    IF NOT EXISTS(SELECT 1 FROM attestation_predecessors m WHERE m.oid=consumer.oid AND m.expected=consumer.prosrc
     AND m.oid NOT IN('application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure,
      'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure))
    THEN RAISE EXCEPTION 'native_helper_attestation_unknown_pin_consumer: %',consumer.oid::regprocedure;END IF;
    body:=replace(replace(replace(consumer.prosrc,quote_literal(previous.pinned_body),quote_literal(previous.current_body)),
     previous.pinned_fingerprint,previous.current_fingerprint),previous.pinned_body_hash,previous.current_hash);
    IF body IS DISTINCT FROM consumer.prosrc THEN
     EXECUTE replace(pg_get_functiondef(consumer.oid),consumer.prosrc,body);
     UPDATE attestation_predecessors SET expected=body WHERE oid=consumer.oid;
     changed:=true;
    END IF;
   END LOOP;
   -- Advance the consumed baseline: a comparator may change again after a
   -- dependency is repinned later in this round. Intermediate pins must also
   -- propagate, independently of catalog iteration order.
   UPDATE attestation_predecessors SET pinned_body=previous.current_body,
    pinned_fingerprint=previous.current_fingerprint,pinned_body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  EXIT WHEN NOT changed;
 END LOOP;
 IF changed THEN RAISE EXCEPTION 'native_helper_attestation_pin_limit';END IF;
 FOR previous IN SELECT m.*,p.prosrc current_body,
  encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint
  FROM attestation_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.original IS DISTINCT FROM p.prosrc LOOP
  UPDATE native_turn_contract_helpers h SET fingerprint=previous.current_fingerprint
   WHERE to_regprocedure('public.'||h.signature)::oid=previous.oid AND h.fingerprint=previous.fingerprint;
  UPDATE native_retained_contract_helpers h SET fingerprint=previous.current_fingerprint
   WHERE to_regprocedure('public.'||h.signature)::oid=previous.oid AND h.fingerprint=previous.fingerprint;
 END LOOP;
 IF EXISTS(SELECT 1 FROM attestation_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
 THEN RAISE EXCEPTION 'native_helper_attestation_successor_metadata_changed';END IF;
 -- Materialize only after every legitimate consumer has reached its final body.
 INSERT INTO public.native_turn_helper_attestations(signature,expected_text)
 SELECT h.signature,to_jsonb(p)::text FROM public.native_turn_contract_helpers h
 JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature);
 IF public.native_turn_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'native_helper_attestation_install_changed';
 END IF;
 FOR signature IN SELECT p.oid::regprocedure::text FROM attestation_predecessors m JOIN pg_proc p ON p.oid=m.oid
  WHERE p.pronargs=0 AND p.prorettype='boolean'::regtype
  UNION SELECT 'native_turn_helpers_current()' UNION SELECT 'native_turn_publication_contract()' LOOP
  EXECUTE 'SELECT '||signature INTO ok;
  IF ok IS NOT TRUE THEN failures:=array_append(failures,signature);END IF;
 END LOOP;
 IF cardinality(failures)>0 THEN RAISE EXCEPTION 'native_helper_attestation_successor_changed: %',failures;END IF;
END $native_helper_attestation_pins$;
COMMIT;
