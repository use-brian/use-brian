BEGIN;
-- [COMP:api/application-persistence] Preserve all source declarations while
-- reducing execution roots inside one independently fresh bounded proof.
DO $covered_prerequisites$
DECLARE actual pg_proc;pins text;trusted text;pin_count integer;trigger_state jsonb;table_state jsonb;shape_sql text;body text;
 fk_state jsonb;fk_query text;previous_pins jsonb;change record;
 original text;definition text;updated text;before text;after text;metadata jsonb;
BEGIN
 -- Reconstruct the existing SQL guard before invoking it. Its catalog
 -- fingerprints are data; the executable template is fixed by migration8152.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'application_empty_query_worklist_reset(jsonb)'::regprocedure,
  'application_empty_query_worklist_current(uuid,jsonb)'::regprocedure,
  'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure);
 trusted:='SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_empty_query_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency existing guard changed';END IF;

 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
  'read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure,
  'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 trusted:='BEGIN
   IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_file_capture_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency file guard changed';END IF;
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
 IF body IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure) THEN RAISE EXCEPTION 'Native field reference dependency guard changed';END IF;
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
 IF body IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure) THEN RAISE EXCEPTION 'File final proof reference guard changed';END IF;
 FOR actual IN SELECT * FROM pg_proc WHERE oid IN(
 'application_native_dependency_batch_helpers_current()'::regprocedure,
 'application_native_field_reference_helpers_current()'::regprocedure) LOOP
 IF actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $guard_metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$guard_metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'File final proof guard metadata changed: %',actual.oid::regprocedure;END IF;
 END LOOP;
 IF application_empty_query_helpers_current() IS NOT TRUE
 OR application_native_file_capture_helpers_current() IS NOT TRUE
 OR application_native_dependency_batch_helpers_current() IS NOT TRUE
 OR application_native_field_reference_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'File final proof canonical prerequisites changed';END IF;
END $covered_prerequisites$;
DO $worklist_prerequisite$
DECLARE pins text;pin_count integer;body text;actual pg_proc;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count FROM pg_proc p WHERE (pronamespace='public'::regnamespace AND proname IN('native_worklist_context','native_worklist_edges','native_worklist_page_dependencies','native_worklist_seed','native_worklist_lineage','native_worklist_snapshot','native_worklist_frame_current','native_worklist_current','native_worklist_current_application_sources','native_worklist_current_knowledge_versions','native_worklist_current_persistent_context','native_worklist_current_public_share','native_worklist_source','native_worklist_source_application_fields','native_worklist_source_blueprint','native_worklist_source_browser_profile','native_worklist_source_browser_session','native_worklist_source_capture','native_worklist_source_conversation','native_worklist_source_engineering_archive','native_worklist_source_knowledge_source_parent','native_worklist_source_knowledge_versions','native_worklist_source_memory_successor','native_worklist_source_page','native_worklist_source_persistent_context','native_worklist_source_primitive_v2','native_worklist_source_recordings','native_worklist_source_workflow_run','native_worklist_eval_domain','native_worklist_eval_envelope','native_worklist_eval_field','native_worklist_eval_point_state','native_worklist_eval_scan','native_worklist_eval_scope','read_native_file_worklist_evidence')) OR oid IN('application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'application_scope_source_edges(uuid,text,uuid,text)'::regprocedure,'application_session_eval_domain(uuid,text,uuid,text[],jsonb)'::regprocedure,'application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure,'application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure,'application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'::regprocedure,'application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure,'application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure,'read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_application_fields(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_blueprint(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_browser_profile(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_browser_session(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_capture(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_conversation(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_memory_successor(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_page(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_persistent_context(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_recordings(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_workflow_run(uuid,text,uuid)'::regprocedure,'read_resource_page_dependencies(uuid,text,uuid,text)'::regprocedure,'application_session_query_parent(uuid,uuid)'::regprocedure,'application_memory_query_context(uuid)'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,'application_memory_statement_helpers_current()'::regprocedure);
 body:='BEGIN
 IF (SELECT count(*)='||pin_count||' AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_empty_query_helpers_current();
 END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_worklist_helpers_current()'::regprocedure;
 IF pin_count<>69 OR actual.prosrc IS DISTINCT FROM body
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname']) IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Covered evidence worklist prerequisite changed';END IF;
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Covered evidence worklist dependencies changed';END IF;
END $worklist_prerequisite$;
DO $static_prerequisites$
DECLARE expected record;actual pg_proc;
BEGIN
 FOR expected IN SELECT * FROM(VALUES
('read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','310f37bf5fc5c989e42c76d6fff068345c95621479cb7716c24f4268b8fdf01b','{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_cohort_frame","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proargtypes":["2950","1009","2951","1009","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('enqueue_native_field_dependency_work()','1b2e74a0e7e01fa74f60aeb04f3e83547bf1f8ed6c3d078e9d192ea6194c364a','{"probin":null,"procost":100,"prokind":"f","proname":"enqueue_native_field_dependency_work","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('validate_application_field_dependencies()','9fed96bf4b30d189a2af7dcc2550837a3de25853e28173985d1eed80605245b6','{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb),
('validate_native_field_dependency_batch(uuid,uuid,jsonb)','c5a69af10d0a81765d3a27c489dbf55b0ef9ebcc7fa334303e966c4eb5b5634b','{"probin":null,"procost":100,"prokind":"f","proname":"validate_native_field_dependency_batch","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","derivation","work"],"proargtypes":["2950","2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb)) p(signature,body_hash,metadata) LOOP
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
 IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex')<>expected.body_hash
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM expected.metadata
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Covered evidence canonical prerequisite changed: %',expected.signature;END IF;
 END LOOP;
END $static_prerequisites$;
SET LOCAL check_function_bodies=off;
DO $install$
DECLARE routine record;recipient record;original_pins jsonb;guard_pin text;pins text;pin_count integer;body text;definition text;original text;changed text;old_pin text;new_pin text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('application_native_covered_queue_current','application_native_root_cover','read_native_covered_memory_frame','read_native_covered_session_frame','validate_native_covered_field_dependency_work','application_native_covered_evidence_helpers_current','read_native_covered_session_evidence')) THEN RAISE EXCEPTION 'Covered evidence helper name already exists';END IF;
 SELECT jsonb_object_agg(proname,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) INTO original_pins FROM pg_proc p WHERE oid IN('enqueue_native_field_dependency_work()'::regprocedure,'validate_application_field_dependencies()'::regprocedure,'application_native_dependency_batch_helpers_current()'::regprocedure);
 EXECUTE $definitions$CREATE FUNCTION application_native_covered_queue_current() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $queue$
DECLARE actual pg_proc;pins text;pin_count integer;trigger_state jsonb;table_state jsonb;shape_sql text;body text;
BEGIN
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
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure;
 IF body IS DISTINCT FROM actual.prosrc OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN RETURN false;END IF;
 RETURN application_native_dependency_batch_helpers_current();
END
$queue$;
$definitions$;
 EXECUTE $definitions$CREATE OR REPLACE FUNCTION public.read_native_covered_memory_frame(w uuid, kinds text[], ids uuid[], versions text[], include_memory boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- A changed original evaluator retains its full original fallback contract.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,nodes)) THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;

 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;

 -- This private argument is created only by this closed SQL operation. It holds
 -- scope metadata, never a Memory business row or a shared selected-field grant.
 IF include_memory AND application_memory_statement_helpers_current() AND (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN
  BEGIN
   PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM id FROM memories WHERE workspace_id=w ORDER BY id FOR SHARE NOWAIT;
   IF NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_context:=application_memory_query_context(w);
   IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_rows:='{}';memory_cohort:='[]';
   FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
    IF memory_lineage IS DISTINCT FROM jsonb_build_array(jsonb_build_object('kind','memory','id',memory_candidate.id,'version',memory_candidate.scope_version::text)) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
    memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
    memory_rows:=memory_rows||jsonb_build_object(memory_candidate.id::text,jsonb_build_object('source',memory_source,'lineage',memory_lineage));
    memory_cohort:=memory_cohort||jsonb_build_array(jsonb_build_object('id',memory_candidate.id,'version',memory_candidate.scope_version::text));
   END LOOP;
   memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows',memory_rows,'cohort',memory_cohort));
  EXCEPTION WHEN lock_not_available THEN memory_rows:=NULL;memory_context:=NULL;memory_cohort:=NULL;
  END;
 END IF;
 -- This private port only exports a qualified locked Memory frame. Without
 -- it the caller must use its original reader, not repeat a discarded full proof.
 IF memo#>>'{memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
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
  IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
   RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
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
 -- Every original derivation envelope still applies, including those on
 -- native ancestors. The full closure contains no raw Entity source; any such
 -- source already delegated above to the unchanged original evaluator.
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN
   RETURN jsonb_build_object('admitted',false);END IF;
 END LOOP;
 -- The evaluator contract is also current at return.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO fresh_nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF nodes IS DISTINCT FROM fresh_nodes THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;

 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,fresh_nodes)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;


 IF memo ? 'memoryStatement' THEN
  IF application_memory_statement_helpers_current() IS NOT TRUE OR application_memory_query_context(w) IS DISTINCT FROM memory_context OR NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',scope_version::text) ORDER BY id),'[]') INTO memory_cohort FROM memories WHERE workspace_id=w;
  IF memory_cohort IS DISTINCT FROM memo#>'{memoryStatement,cohort}' THEN RETURN NULL;END IF;
  FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
   memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
   IF memory_source IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'source'] OR memory_lineage IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'lineage'] THEN RETURN NULL;END IF;
  END LOOP;
 END IF;
 -- This frame is private to the definer capture in this same SQL invocation.
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents,'memo',memo,'lineage',fresh_nodes);
END $function$
$definitions$;
 EXECUTE $definitions$-- [COMP:api/application-persistence] Cover selection is traversal metadata only.
CREATE FUNCTION application_native_root_cover(w uuid,roots jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE selected jsonb:='[]';nodes jsonb:='[]';part jsonb;root jsonb;
BEGIN
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE (r->>'kind' IN('application_field','session_message','session_context_revision','workspace_file','memory')
  AND r->>'id' IS NOT NULL AND r->>'version' IS NOT NULL) IS NOT TRUE) THEN RETURN NULL;END IF;
 -- Prefer query domains; their exact recorded children often cover the other
 -- original fields. No original declaration or permission floor is removed.
 FOR root IN SELECT r FROM jsonb_array_elements(roots) r LEFT JOIN application_field_resources f
  ON r->>'kind'='application_field' AND f.workspace_id=w AND f.id=(r->>'id')::uuid
  ORDER BY (f.selection='query_domain') DESC NULLS LAST,r->>'version',r->>'kind',r->>'id' LOOP
  IF nodes @> jsonb_build_array(root) THEN CONTINUE;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO part
   FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) n;
  SELECT jsonb_agg(n ORDER BY n->>'kind',n->>'id',n->>'version') INTO nodes
   FROM(SELECT DISTINCT n FROM jsonb_array_elements(nodes||part) n LIMIT 4097) bounded;
  IF jsonb_array_length(nodes)>4096 THEN RETURN NULL;END IF;
  -- A later domain can subsume earlier representatives. Prune those exact
  -- roots before applying the execution-input bound, without dropping any
  -- original declaration or accumulated lineage obligation.
  SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]') INTO selected FROM jsonb_array_elements(selected) r
   WHERE NOT part @> jsonb_build_array(r);
  selected:=selected||jsonb_build_array(root);
  IF jsonb_array_length(selected)>100 THEN RETURN NULL;END IF;
 END LOOP;
 IF native_worklist_edges(w,nodes) IS NULL OR application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('roots',selected,'lineage',nodes);
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;RAISE;
END $$;

CREATE FUNCTION read_native_covered_session_frame(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roots jsonb;cover jsonb;proof jsonb;chosen jsonb;context jsonb;
BEGIN
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF w IS NULL OR kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096
 OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
 OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL
 OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 SELECT jsonb_agg(root ORDER BY root::text) INTO roots FROM(SELECT DISTINCT jsonb_build_object('kind',k,'id',i,'version',v) root FROM unnest(kinds,ids,versions) r(k,i,v)) unique_roots;
 cover:=application_native_root_cover(w,roots);IF cover IS NULL THEN RETURN NULL;END IF;
 chosen:=cover->'roots';context:=native_worklist_context(w,cover->'lineage');
 kinds:=ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(chosen) r);
 ids:=ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(chosen) r);
 versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(chosen) r);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(cover->'lineage') n WHERE n->>'kind'='workspace_file') THEN
  proof:=read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
 ELSE
  proof:=read_native_covered_memory_frame(w,kinds,ids,versions,true);
 END IF;
 -- A representative being refused is not a new denial contract: the original
 -- whole-input reader decides unsupported or changed cases.
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR proof->'lineage' IS DISTINCT FROM cover->'lineage'
 OR NOT (proof->'lineage') @> roots OR native_worklist_context(w,proof->'lineage') IS DISTINCT FROM context
 OR application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN proof||jsonb_build_object('executionRoots',chosen);
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;RAISE;
END $$;
$definitions$;
 EXECUTE $definitions$CREATE FUNCTION validate_native_covered_field_dependency_work(w uuid,derivation uuid,operation_txid bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE output scope_derivations;roots jsonb;fields jsonb;proof jsonb;cover_roots jsonb;work jsonb;work_count integer;dependency record;source jsonb;current jsonb;
 kinds text[];ids uuid[];versions text[];
BEGIN
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 SELECT count(*) INTO work_count FROM(SELECT id FROM native_field_dependency_work q
 WHERE q.transaction_id=operation_txid AND q.workspace_id=w AND q.derivation_id=derivation AND q.fired AND NOT q.processed LIMIT 4097) bounded;
 IF work_count NOT BETWEEN 2 AND 4096 THEN RETURN false;END IF;
 SELECT jsonb_agg(bounded.source ORDER BY bounded.id) INTO work FROM(SELECT q.id,q.source FROM native_field_dependency_work q
 WHERE q.transaction_id=operation_txid AND q.workspace_id=w AND q.derivation_id=derivation AND q.fired AND NOT q.processed ORDER BY q.id LIMIT 4096) bounded;
 IF application_native_covered_queue_current() IS NOT TRUE THEN RETURN false;END IF;
 IF jsonb_typeof(work) IS DISTINCT FROM 'array' OR jsonb_array_length(work)<2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(work) item WHERE item->>'workspace_id' IS DISTINCT FROM w::text
   OR item->>'derivation_id' IS DISTINCT FROM derivation::text
   OR item->>'source_kind' NOT IN('application_field','session_context_revision','session_message','memory','workspace_file'))
  OR current_setting('app.crm_erasure_capture',true)='on'
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='public.scope_derivation_sources'::regclass
   WHERE role.rolname=session_user AND(role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN false;END IF;
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=w AND id=derivation;
 IF NOT FOUND THEN RETURN true;END IF;
 IF output.resource_kind NOT IN('session_message','session_context_revision') THEN RETURN false;END IF;
 SELECT jsonb_agg(root ORDER BY root::text) INTO roots FROM(
  SELECT DISTINCT jsonb_build_object('kind',item->'source_kind','id',item->'source_id','version',item->'source_version') root
  FROM jsonb_array_elements(work) item) unique_roots;
 IF jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 THEN RETURN false;END IF;
 kinds:=ARRAY(SELECT root->>'kind' FROM jsonb_array_elements(roots) root);
 ids:=ARRAY(SELECT (root->>'id')::uuid FROM jsonb_array_elements(roots) root);
 versions:=ARRAY(SELECT root->>'version' FROM jsonb_array_elements(roots) root);
 proof:=read_native_covered_session_frame(w,kinds,ids,versions);
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'lineage') n WHERE n->>'kind'='workspace_file') THEN RETURN false;END IF;
 cover_roots:=proof->'executionRoots';
 kinds:=ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(cover_roots) r);
 ids:=ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(cover_roots) r);
 versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(cover_roots) r);
 -- Only native non-history fields may take this branch. Unsupported fields
 -- and historical Memory retain the complete original per-event validator.
 SELECT coalesce(jsonb_agg(jsonb_build_object('node_version',d.node_version,'source',d.source) ORDER BY d.source->>'resourceId',d.node_version),'[]')
 INTO fields FROM read_application_field_dependencies(w,kinds,ids,versions) d;
 IF jsonb_array_length(fields) NOT BETWEEN 2 AND 4096 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(fields) d LEFT JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(d#>>'{source,resourceId}')::uuid
  WHERE f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR f.type_key NOT IN('session_message','session_message_annotation','memory')
   OR f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')) THEN RETURN false;END IF;
 IF proof->>'admitted' IS DISTINCT FROM 'true' OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(fields) field
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'current') point
   WHERE point->>'resourceKind'='application_field' AND point->>'resourceId'=field#>>'{source,resourceId}'
    AND point->>'version'=field->>'node_version')) THEN RETURN false;END IF;
 IF application_native_covered_queue_current() IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_file_frame_current(w,kinds,ids,versions,proof) IS NOT TRUE THEN RETURN false;END IF;
 -- The private frame buffers complete current sources behind another fresh
 -- proof. These are unchanged declaration/label checks, not reused permission.
 FOR dependency IN SELECT d->>'node_version' AS node_version,d->'source' AS source FROM jsonb_array_elements(fields) d LOOP
  source:=dependency.source;
  IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources declared WHERE declared.workspace_id=w AND declared.derivation_id=derivation
   AND declared.source_kind='application_field' AND declared.source_id=(source->>'resourceId')::uuid AND declared.source_version=dependency.node_version) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM output.user_id::text
   AND source->>'userId' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 END LOOP;
 -- The eligible closed frame contains no external source. If a fresh
 -- discovery changes that, replay each original event, including its original
 -- has_fields gate, retention checks and output labels.
 IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,kinds,ids,versions)) THEN RETURN false;END IF;
 IF application_native_covered_queue_current() IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN false;END IF;RAISE;
END $body$;
$definitions$;
 EXECUTE 'CREATE FUNCTION application_native_covered_evidence_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $stub$ BEGIN RETURN false;END $stub$';
 FOR routine IN SELECT * FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('application_native_covered_queue_current','application_native_root_cover','read_native_covered_memory_frame','read_native_covered_session_frame','validate_native_covered_field_dependency_work','application_native_covered_evidence_helpers_current') LOOP
 FOR recipient IN SELECT DISTINCT grantee FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a WHERE a.grantee<>routine.proowner LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',routine.oid::regprocedure,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
 END LOOP;
 END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count FROM pg_proc p WHERE (pronamespace='public'::regnamespace AND proname IN('application_native_covered_queue_current','application_native_root_cover','read_native_covered_memory_frame','read_native_covered_session_frame','validate_native_covered_field_dependency_work')) OR oid IN('read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'application_native_worklist_helpers_current()'::regprocedure,'native_worklist_edges(uuid,jsonb)'::regprocedure,'native_worklist_context(uuid,jsonb)'::regprocedure,'application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'read_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'read_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,'application_memory_statement_helpers_current()'::regprocedure);
 IF pin_count<>17 THEN RAISE EXCEPTION 'Covered evidence helper roster changed';END IF;
 body:='BEGIN
 IF (SELECT count(*)=17 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_worklist_helpers_current();
 END';
 EXECUTE format('CREATE OR REPLACE FUNCTION application_native_covered_evidence_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure;
 EXECUTE replace($facade$
 CREATE FUNCTION read_native_covered_session_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
 DECLARE proof jsonb;
 BEGIN
 -- This additional entry point must not bypass revocation of the existing
 -- attended Memory/file readers. Decline before any private proof is read.
 IF has_function_privilege(session_user,to_regprocedure('public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'),'EXECUTE') IS NOT TRUE
 OR has_function_privilege(session_user,to_regprocedure('public.read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'),'EXECUTE') IS NOT TRUE THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RETURN NULL;END IF;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 proof:=read_native_covered_session_frame(w,kinds,ids,versions);
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RETURN NULL;END IF;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE OR proof->>'admitted' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',proof->'immutable','current',proof->'current');
 END $body$;
 $facade$,'__GUARD__',guard_pin);
 -- Normalize facade defaults too, then expose only its identity-only API.
 SELECT * INTO routine FROM pg_proc WHERE oid='read_native_covered_session_evidence(uuid,text[],uuid[],text[])'::regprocedure;
 FOR recipient IN SELECT DISTINCT grantee FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a WHERE a.grantee<>routine.proowner LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',routine.oid::regprocedure,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_covered_session_evidence(uuid,text[],uuid[],text[]) TO app_user;END IF;

 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc WHERE oid='enqueue_native_field_dependency_work()'::regprocedure;
 changed:=replace(original,'queued_events>=100','queued_events>=4096');
 IF changed=original THEN RAISE EXCEPTION 'Covered evidence queue bound changed';END IF;
 EXECUTE replace(definition,original,changed);

 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc WHERE oid='validate_application_field_dependencies()'::regprocedure;
 changed:=replace(original,$old$   IF validate_native_field_dependency_batch(NEW.workspace_id,NEW.derivation_id,work_rows) IS TRUE THEN work_rows:='[]';END IF;$old$,
 replace($new$   IF validate_native_field_dependency_batch(NEW.workspace_id,NEW.derivation_id,work_rows) IS TRUE THEN work_rows:='[]';
   ELSIF batch_header.queued_events<=4096 AND (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure)='__GUARD__' THEN
    IF application_native_covered_evidence_helpers_current() IS TRUE THEN
     IF validate_native_covered_field_dependency_work(NEW.workspace_id,NEW.derivation_id,operation_txid) IS TRUE THEN
      IF (SELECT encode(sha256(convert_to(to_jsonb(catalog_proc)::text,'UTF8')),'hex') FROM pg_proc catalog_proc WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure)='__GUARD__' THEN
       IF application_native_covered_evidence_helpers_current() IS TRUE AND application_native_dependency_batch_helpers_current() IS TRUE THEN work_rows:='[]';END IF;
      END IF;
     END IF;
    END IF;
   END IF;$new$,'__GUARD__',guard_pin));
 IF changed=original THEN RAISE EXCEPTION 'Covered evidence scheduler changed';END IF;
 EXECUTE replace(definition,original,changed);

 -- Only the two scheduler rows and their existing dependent guard change.
 FOR routine IN SELECT * FROM (VALUES
 ('enqueue_native_field_dependency_work','application_native_dependency_batch_helpers_current()'::regprocedure),
 ('validate_application_field_dependencies','application_native_dependency_batch_helpers_current()'::regprocedure),
 ('application_native_dependency_batch_helpers_current','application_native_field_reference_helpers_current()'::regprocedure)) transition(source,target) LOOP
 old_pin:=original_pins->>routine.source;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO new_pin FROM pg_proc p WHERE pronamespace='public'::regnamespace AND proname=routine.source;
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc WHERE oid=routine.target;
 IF old_pin IS NULL OR new_pin IS NULL OR old_pin=new_pin OR length(original)-length(replace(original,old_pin,''))<>length(old_pin) THEN RAISE EXCEPTION 'Covered evidence dependency pin changed';END IF;
 EXECUTE replace(definition,old_pin,new_pin);
 END LOOP;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE OR application_native_dependency_batch_helpers_current() IS NOT TRUE
 OR application_native_field_reference_helpers_current() IS NOT TRUE OR application_native_file_capture_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'Covered evidence final guards failed';END IF;
END $install$;
SET LOCAL check_function_bodies=on;
DO $validate_bodies$
DECLARE routine record;
BEGIN
 FOR routine IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN(
 'application_native_covered_queue_current','application_native_root_cover','read_native_covered_memory_frame','read_native_covered_session_frame',
 'validate_native_covered_field_dependency_work','application_native_covered_evidence_helpers_current','read_native_covered_session_evidence') LOOP
 EXECUTE pg_get_functiondef(routine.oid);
 END LOOP;
END $validate_bodies$;
COMMIT;
