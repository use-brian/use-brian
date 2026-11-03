BEGIN;
-- [COMP:api/migration-owner-role] Repair only legacy ACLs embedded in the flat
-- dependency guards before 8195 authenticates their exact predecessor bodies.
-- Some deployments ran setup BEFORE 81850, freezing app_user/debug queue grants
-- into these bodies. 81940/81941 remove the grants but cannot update snapshots.
-- Authenticate the complete executable template and all current catalog rows,
-- allowing only the known historical runtime/debug relation ACL overlays.
-- Never bless arbitrary catalog or function drift by blindly rebaking a guard.
DO $legacy_dependency_acl_snapshots$
DECLARE actual pg_proc;body text;pins text;pin_count integer;definition text;
 trigger_state jsonb;table_state jsonb;shape_sql text;fk_query text;fk_state jsonb;
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 member_oids oid[];dependency_tables text;own_tables text;
 original_dependency pg_proc;auth_rows text;auth_body text;candidate text;
 legacy_tables jsonb;legacy_fk jsonb;variant integer;accepted boolean;
 original_metadata jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8195_native_publication_invalidation_contract.sql') THEN RETURN;END IF;
 SELECT * INTO STRICT original_dependency FROM pg_proc
 WHERE oid='public.application_native_dependency_batch_helpers_current()'::regprocedure;
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
 EXECUTE 'SELECT string_agg(''(''||'||replace(row_sql,'p.prosrc','(CASE WHEN p.oid=$2 THEN $3 ELSE p.prosrc END)')||'||'')'','','' ORDER BY p.oid)
 FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)'
 INTO auth_rows USING member_oids,original_dependency.oid,original_dependency.prosrc;
  body:='BEGIN IF (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb THEN RETURN false;END IF; IF (SELECT count(*)='||cardinality(member_oids)||' AND coalesce(bool_and('||comparisons||'),false) FROM (VALUES '||rows_sql||') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;'||''||dependency_tables||'RETURN true;END';
 SELECT * INTO actual FROM pg_proc WHERE oid='public.application_native_dependency_batch_helpers_current()'::regprocedure;
 IF actual.oid IS NULL OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname']) IS DISTINCT FROM
   '{"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
 original_metadata:=to_jsonb(actual)-'prosrc';
 auth_body:=replace(body,rows_sql,auth_rows);
 accepted:=false;
 FOR variant IN 0..3 LOOP
  -- A setup run may have restored runtime grants, debug grants, both or none.
  -- Preserve original owner entries/order; accept no unknown principals,
  -- grant options, altered triggers, expressions, columns or function rows.
  legacy_tables:=table_state;
  IF variant<>0 THEN
   legacy_tables:=jsonb_set(table_state,'{relations}',(
    SELECT jsonb_agg(CASE WHEN (variant & 1)<>0 OR relation.value->>3<>'S' AND (variant & 2)<>0
     THEN jsonb_set(relation.value,'{2}',
      coalesce(nullif(relation.value->2,'null'::jsonb),to_jsonb(acldefault(
       CASE WHEN relation.value->>3='S' THEN 'S'::"char" ELSE 'r'::"char" END,(relation.value->>1)::oid)))
      ||CASE WHEN (variant & 1)<>0 THEN jsonb_build_array(format('%I=%s/%I','app_user',
       CASE WHEN relation.value->>3='S' THEN 'rU' ELSE 'arwd' END,pg_get_userbyid((relation.value->>1)::oid))) ELSE '[]'::jsonb END
      ||CASE WHEN (variant & 2)<>0 AND relation.value->>3<>'S' THEN jsonb_build_array(
       format('%I=r/%I','brian-debug',pg_get_userbyid((relation.value->>1)::oid))) ELSE '[]'::jsonb END)
     ELSE relation.value END ORDER BY relation.ordinality)
    FROM jsonb_array_elements(table_state->'relations') WITH ORDINALITY relation(value,ordinality)));
  END IF;
  candidate:=left(auth_body,length(auth_body)-length(dependency_tables||'RETURN true;END'))
   ||replace(dependency_tables,quote_literal(table_state::text),quote_literal(legacy_tables::text))||'RETURN true;END';
  IF actual.prosrc IS NOT DISTINCT FROM candidate THEN accepted:=true;EXIT;END IF;
 END LOOP;
 IF NOT accepted THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot prerequisite changed: %',actual.oid::regprocedure;END IF;
 IF body IS DISTINCT FROM actual.prosrc THEN
  definition:=pg_get_functiondef(actual.oid);EXECUTE replace(definition,actual.prosrc,body);
 END IF;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=actual.oid) IS DISTINCT FROM original_metadata
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
 -- field_reference embeds dependency_batch fingerprints; rebuild after the bake above.
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
 EXECUTE 'SELECT string_agg(''(''||'||replace(row_sql,'p.prosrc','(CASE WHEN p.oid=$2 THEN $3 ELSE p.prosrc END)')||'||'')'','','' ORDER BY p.oid)
 FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)'
 INTO auth_rows USING member_oids,original_dependency.oid,original_dependency.prosrc;
  body:='BEGIN IF (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb THEN RETURN false;END IF; IF (SELECT count(*)='||cardinality(member_oids)||' AND coalesce(bool_and('||comparisons||'),false) FROM (VALUES '||rows_sql||') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;'||own_tables||dependency_tables||'RETURN true;END';
 SELECT * INTO actual FROM pg_proc WHERE oid='public.application_native_field_reference_helpers_current()'::regprocedure;
 IF actual.oid IS NULL OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname']) IS DISTINCT FROM
   '{"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
 original_metadata:=to_jsonb(actual)-'prosrc';
 auth_body:=replace(body,rows_sql,auth_rows);
 accepted:=false;
 FOR variant IN 0..3 LOOP
  legacy_tables:=table_state;
  IF variant<>0 THEN
   legacy_tables:=jsonb_set(table_state,'{relations}',(
    SELECT jsonb_agg(CASE WHEN (variant & 1)<>0 OR relation.value->>3<>'S' AND (variant & 2)<>0
     THEN jsonb_set(relation.value,'{2}',
      coalesce(nullif(relation.value->2,'null'::jsonb),to_jsonb(acldefault(
       CASE WHEN relation.value->>3='S' THEN 'S'::"char" ELSE 'r'::"char" END,(relation.value->>1)::oid)))
      ||CASE WHEN (variant & 1)<>0 THEN jsonb_build_array(format('%I=%s/%I','app_user',
       CASE WHEN relation.value->>3='S' THEN 'rU' ELSE 'arwd' END,pg_get_userbyid((relation.value->>1)::oid))) ELSE '[]'::jsonb END
      ||CASE WHEN (variant & 2)<>0 AND relation.value->>3<>'S' THEN jsonb_build_array(
       format('%I=r/%I','brian-debug',pg_get_userbyid((relation.value->>1)::oid))) ELSE '[]'::jsonb END)
     ELSE relation.value END ORDER BY relation.ordinality)
    FROM jsonb_array_elements(table_state->'relations') WITH ORDINALITY relation(value,ordinality)));
  END IF;
  legacy_fk:=fk_state;
  IF (variant & 2)<>0 THEN
   legacy_fk:=jsonb_set(fk_state,'{relations}',(
    SELECT jsonb_agg(jsonb_set(relation.value,'{2}',
     coalesce(nullif(relation.value->2,'null'::jsonb),to_jsonb(acldefault('r',(relation.value->>1)::oid)))
     ||jsonb_build_array(format('%I=r/%I','brian-debug',pg_get_userbyid((relation.value->>1)::oid)))) ORDER BY relation.ordinality)
    FROM jsonb_array_elements(fk_state->'relations') WITH ORDINALITY relation(value,ordinality)));
  END IF;
  candidate:=left(auth_body,length(auth_body)-length(own_tables||dependency_tables||'RETURN true;END'))
   ||replace(own_tables,quote_literal(fk_state::text),quote_literal(legacy_fk::text))
   ||replace(dependency_tables,quote_literal(table_state::text),quote_literal(legacy_tables::text))||'RETURN true;END';
  IF actual.prosrc IS NOT DISTINCT FROM candidate THEN accepted:=true;EXIT;END IF;
 END LOOP;
 IF NOT accepted THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot prerequisite changed: %',actual.oid::regprocedure;END IF;
 IF body IS DISTINCT FROM actual.prosrc THEN
  definition:=pg_get_functiondef(actual.oid);EXECUTE replace(definition,actual.prosrc,body);
 END IF;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=actual.oid) IS DISTINCT FROM original_metadata
 THEN RAISE EXCEPTION 'Legacy dependency ACL snapshot metadata changed';END IF;
END $legacy_dependency_acl_snapshots$;
COMMIT;
