BEGIN;
-- [COMP:api/application-persistence] Reuse traversal data only inside one closed
-- proof; independent canonical current reads and exact edge/context equality end it.
DO $capture$
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
END $capture$;
DO $prerequisites_application_empty_query_facades_current$
DECLARE pins text;trusted text;actual pg_proc;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_empty_query_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,
  'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,
  'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'session_context_file_revision_allowed(uuid,uuid)'::regprocedure,
  'read_session_context_file_revision(uuid,uuid)'::regprocedure,
  'read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure);
 trusted:=
  'BEGIN
   IF (SELECT count(*)=8 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_empty_query_facades_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native worklist existing guard changed: application_empty_query_facades_current()';END IF;
 -- The 8152/127 prerequisite must be independently validated before this block.
 IF application_empty_query_facades_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native worklist existing helpers changed: application_empty_query_facades_current()';END IF;
END $prerequisites_application_empty_query_facades_current$;

DO $prerequisites_application_native_title_group_helpers_current$
DECLARE pins text;trusted text;actual pg_proc;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_personal_title_group(uuid,uuid[],uuid[])'::regprocedure,
  'read_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_session_context_revision(uuid,uuid)'::regprocedure,
  'session_context_revision_allowed(uuid,uuid)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 trusted:=
  'BEGIN IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
   FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_title_group_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native worklist existing guard changed: application_native_title_group_helpers_current()';END IF;
 -- The 8152/127 prerequisite must be independently validated before this block.
 IF application_native_title_group_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native worklist existing helpers changed: application_native_title_group_helpers_current()';END IF;
END $prerequisites_application_native_title_group_helpers_current$;
DO $canonical$
DECLARE expected record;actual pg_proc;
BEGIN
 FOR expected IN SELECT * FROM(VALUES
('application_scope_source_edges(uuid,text,uuid,text)','eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_source_edges","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_domain(uuid,text,uuid,text[],jsonb)','47d45fe98cde529fd5bf6c01b9f3fc91cf891219aa94a0ade096fd290053911b','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_domain","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","fields","memo"],"proargtypes":["2950","25","2950","1009","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','938e4d4ebc47e7f4b0fb5aa6cfbc69ea199150f7e1eac784aaa0aa045cb47af0','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_envelope","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","selection","fields","memo"],"proargtypes":["2950","25","2950","25","1009","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_field(uuid,uuid,text,jsonb)','3f067d801bca03c79d6dc4ad15a00f3abc64ad8857b770509a8bef915373d276','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_field","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","memo"],"proargtypes":["2950","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','84bb11a613edf6e1fc7a87b06812535e5fe4b15f882f5ef636be2168e71ffa14','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_point_state","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","fields","memo"],"proargtypes":["2950","25","2950","1009","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','8f01ca980231ecab5963092178ec34d322986d6cd3451b2a037bc721721bae18','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scan","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","t","through","fields","bounds","visibility","memo"],"proargtypes":["2950","2950","25","23","1009","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_eval_scope(uuid,text,uuid,text,jsonb)','c3a7c0a139f1c789e9432bdbe3084f246c898c2ac6bcbf5b6531edcc28418c4b','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proargtypes":["2950","25","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_admitted_native_scope_snapshot(uuid,text,uuid)','90863ef2037d3e5326381afeba23052971da0263006cb83116c68ddf3ac48b78','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','1da6fae5f8e50f4f9d1e5a3af483c10e6671e36bdd0286873b0efa14cacb1791','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot_before_application_sources","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','bc3db1aed4d28b1b2370f93814113a706114017651b20986715bde843a07a24d','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot_before_knowledge_versions","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','6ae4d0a5a9420a4f20f76aa9d8c7e6c066add8635517affcdda2f386d2260ac0','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot_before_persistent_context","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','a53d51bdf98388324428e2f31f7cefbcb0464cefa42b6827060aa523bdca07ab','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot_before_public_share","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source(uuid,text,uuid)','e707edb588228a6e18790026bd886c4946b5c2adcff0b7428ebfb0fb43e052f3','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_application_fields(uuid,text,uuid)','5d676d04f8b25511b5d03def6cdc153d7cef32778726bb1953ed25b2d64ce499','sql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_application_fields","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_blueprint(uuid,text,uuid)','6d5e4db46f88db7fc95887bf9c27dc8b559a1454c915259c7fbd00c71e079efe','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_blueprint","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','db659d6fd7c52b9cbbf2ae9e0700e85528a3b33a18496bc6ba04374330da11c6','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_browser_profile","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_browser_session(uuid,text,uuid)','82efb78e665175f49435b22bdd4e833dc6fee137538b48201ca4d3de87b406b0','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_browser_session","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_capture(uuid,text,uuid)','cdc03dd1c41f3a47d810a4f3acc0e53d2697e255a74b461b6fa4194b89419333','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_capture","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,true),
('read_entity_derivation_source_before_conversation(uuid,text,uuid)','84470b7e75dab7a200af9b8a36c67e30049c4d63b6167bb9ae1fb5d1a02cf684','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_conversation","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','8cecfe01edcc675b99b24fce8470332ae1268086eedd627cb12791905f534440','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_engineering_archive","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','d77c03dff1ca14de5989a2b9ac7245c8fe53cad9157bd07d4a3903c48dc4f090','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_knowledge_source_parent","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','9e7b910d3b342a84e4bc9176c3b361ead9b4e33c0e17cd997cc2f3798f282747','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_knowledge_versions","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','7a6319985c3df2597f7c97701de1ac66f5f2737b73439363b55a81866d4bc07a','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_memory_successor","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_page(uuid,text,uuid)','7fa59b5ad9959eeea213555827788178876559d50f9b8901177323ee7c01479f','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_page","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','e0ca32ac14a733040338a7cf1b33a7219cb289555491c3b9574e5e5fc10276d9','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_persistent_context","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','cf37a2b56386164b97a10dc6481746db525f142d4fb8bdc2c7b669e59e9b9757','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_primitive_v2","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_recordings(uuid,text,uuid)','4125a24719ffa24669e0ee6895f3c3799a82d9612799a1da5f2a788f98ada99d','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_recordings","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','729355a67ae979e9648492b81e6ba6ed818cb958be736ce980db5ccc49307dec','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source_before_workflow_run","prorows":0,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','336ab4c9ca98f3498c070a243ab72df1d92feeadbce9fb1920e73f7322f7555a','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_cohort_frame","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proargtypes":["2950","1009","2951","1009","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','b5e7109655436be0bd985c9ef13f5f2bd556a6b513e4026a85d67c07da8193ac','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proargtypes":["2950","1009","2951","1009","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('read_resource_page_dependencies(uuid,text,uuid,text)','d274ecd7383a04fce33a8b8a579f9db21e9538dd8e33fb455b010fce86b49646','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_resource_page_dependencies","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_session_query_parent(uuid,uuid)','85393998bba4fe1af647bbfaade0ae59e364081e4bbea4de1e57ccaf86cbd2e1','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_parent","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('application_memory_query_context(uuid)','01005c743471b53304ef3b6c2b5154f67961231496c4be53e24b85cbce3f93bd','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_query_context","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('session_context_file_revision_allowed(uuid,uuid)','0c5191609b4ee47e2e43ed447ed50bc6001a832cbf037fdfc0a967241e6d0c8b','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"session_context_file_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_session_context_file_revision(uuid,uuid)','ec4636eb884f9a4bf5bd0c0ac6fb5eed1aed64c1cd790d823467be5682db1a99','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_file_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_native_file_session_title_revision(uuid,uuid,uuid)','896e852d3284bdfc7df82e575299ba6115beffc2476f07e2e00917376042f15e','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false),
('session_context_empty_query_revision_allowed(uuid,uuid)','8fb6a34f02181fe16b14fb6617d4bbb138accad2827600c2760aa01eb33fd65f','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"session_context_empty_query_revision_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_session_context_empty_query_revision(uuid,uuid)','0da479eec0cdb78a236e05f07324d60ceec224b58ce4cd32190fd0938ee35917','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_session_context_empty_query_revision","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,false,false),
('read_native_empty_query_session_title_revision(uuid,uuid,uuid)','c08cbd67bab90c417bc9f1505b0a4eb2a85dbe48783daa0cd81e3ca01bf68f9a','plpgsql','{"probin":null,"procost":100,"prokind":"f","proname":"read_native_empty_query_session_title_revision","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","i"],"proargtypes":["2950","2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}'::jsonb,true,false)) pin(signature,body_hash,language,metadata,application_execute,public_execute) LOOP
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
 IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex')<>expected.body_hash
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected.language)
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM expected.metadata
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
  WHERE a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
   OR NOT(a.grantee=actual.proowner OR expected.application_execute AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user' AND oid=a.grantee)
    OR expected.public_execute AND a.grantee=0))
 THEN RAISE EXCEPTION 'Native worklist canonical prerequisite changed: %',expected.signature;END IF;
 END LOOP;
END $canonical$;
SET LOCAL check_function_bodies=off;
DO $install$
DECLARE original_pins jsonb;original_bodies jsonb;row record;recipient record;old_pin text;new_pin text;old_hash text;new_hash text;body text;definition text;pins text;pin_count integer;
BEGIN
 SELECT jsonb_object_agg(proname,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),jsonb_object_agg(proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex')) INTO original_pins,original_bodies FROM pg_proc p WHERE oid IN('application_empty_query_facades_current()'::regprocedure,'application_native_dependency_batch_helpers_current()'::regprocedure,'application_native_field_reference_helpers_current()'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'application_native_title_group_helpers_current()'::regprocedure,'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure,'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure,'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,'read_session_context_file_revision(uuid,uuid)'::regprocedure,'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,'session_context_file_revision_allowed(uuid,uuid)'::regprocedure);
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('native_worklist_context','native_worklist_edges','native_worklist_page_dependencies','native_worklist_seed','native_worklist_lineage','native_worklist_snapshot','native_worklist_frame_current','native_worklist_current','native_worklist_current_application_sources','native_worklist_current_knowledge_versions','native_worklist_current_persistent_context','native_worklist_current_public_share','native_worklist_source','native_worklist_source_application_fields','native_worklist_source_blueprint','native_worklist_source_browser_profile','native_worklist_source_browser_session','native_worklist_source_capture','native_worklist_source_conversation','native_worklist_source_engineering_archive','native_worklist_source_knowledge_source_parent','native_worklist_source_knowledge_versions','native_worklist_source_memory_successor','native_worklist_source_page','native_worklist_source_persistent_context','native_worklist_source_primitive_v2','native_worklist_source_recordings','native_worklist_source_workflow_run','native_worklist_eval_domain','native_worklist_eval_envelope','native_worklist_eval_field','native_worklist_eval_point_state','native_worklist_eval_scan','native_worklist_eval_scope','read_native_file_worklist_evidence','application_native_worklist_helpers_current')) THEN RAISE EXCEPTION 'Native worklist helper name already exists';END IF;
 EXECUTE $definitions$CREATE FUNCTION native_worklist_context(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE settings jsonb;parents jsonb;context jsonb;
BEGIN
 SELECT jsonb_object_agg(setting,current_setting(setting,true)) INTO settings FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']::text[]) setting;
 SELECT coalesce(jsonb_object_agg(session_id::text,application_session_query_parent(w,session_id) ORDER BY session_id),'{}') INTO parents FROM(
  SELECT m.session_id FROM jsonb_array_elements(nodes) n JOIN session_messages m ON (n->>'kind')='session_message' AND m.workspace_id=w AND m.id=((n->>'id'))::uuid
  UNION SELECT r.session_id FROM jsonb_array_elements(nodes) n JOIN session_context_scope_revisions r ON (n->>'kind')='session_context_revision' AND r.workspace_id=w AND r.id=((n->>'id'))::uuid
  UNION SELECT ((q.domain->>'sessionId'))::uuid FROM jsonb_array_elements(nodes) n JOIN application_query_domains q
   ON (n->>'kind')='application_query_domain' AND q.workspace_id=w AND q.id=((n->>'id'))::uuid
   WHERE (q.domain->>'sessionId') IS NOT NULL) sessions;
 context:=application_memory_query_context(w);
 RETURN jsonb_build_object('workspaceId',w,'sessionUser',session_user,'currentUser',current_user,'settings',settings,'memory',context,'parents',parents);
END $$;
CREATE FUNCTION native_worklist_edges(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH parents AS MATERIALIZED(SELECT n->>'kind' kind,(n->>'id')::uuid id,n->>'version' version,
  (n->>'kind')||':'||(n->>'id')||':'||(n->>'version') key FROM jsonb_array_elements(nodes) n),
 edges AS MATERIALIZED(SELECT parent.key,to_jsonb(edge) child FROM parents parent
  CROSS JOIN LATERAL application_scope_source_edges(w,parent.kind,parent.id,parent.version) edge LIMIT 16385),
 grouped AS(SELECT key,jsonb_agg(child ORDER BY child->>'kind',child->>'id',child->>'version') children FROM edges GROUP BY key)
 SELECT CASE WHEN (SELECT count(*) FROM edges)>16384 THEN NULL ELSE
  (SELECT coalesce(jsonb_object_agg(parent.key,coalesce(grouped.children,'[]')),'{}') FROM parents parent LEFT JOIN grouped USING(key)) END
$$;
CREATE FUNCTION native_worklist_page_dependencies(w uuid,k text,i uuid,v text,worklist_frame jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (worklist_frame->>'workspaceId')=w::text AND (worklist_frame->>'closed')='true'
  AND k IN('session_message','session_context_revision','workspace_file','memory')
  AND worklist_frame->'edges' ? (k||':'||i||':'||v) THEN RETURN '[]'::jsonb;END IF;
 RETURN read_resource_page_dependencies(w,k,i,v);
END $$;
CREATE FUNCTION native_worklist_seed(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame jsonb;edges jsonb;currents jsonb:='{}';node record;source jsonb;context jsonb;
BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF w IS NULL OR jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes) NOT BETWEEN 1 AND 4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE ((n->>'kind') IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file','memory')
   AND (n->>'id') IS NOT NULL AND (n->>'version') IS NOT NULL) IS NOT TRUE) THEN RETURN NULL;END IF;
 edges:=native_worklist_edges(w,nodes);
 IF edges IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(edges) parent CROSS JOIN LATERAL jsonb_array_elements(parent.value) child
  WHERE NOT edges ? ((child->>'kind')||':'||(child->>'id')||':'||(child->>'version'))) THEN RETURN NULL;END IF;
 context:=native_worklist_context(w,nodes);
 frame:=jsonb_build_object('workspaceId',w,'closed',true,'nodes',nodes,'edges',edges,'context',context,'currents',currents);
 FOR node IN SELECT DISTINCT (n->>'kind') kind,((n->>'id'))::uuid id FROM jsonb_array_elements(nodes) n
  WHERE (n->>'kind') IN('session_message','session_context_revision','workspace_file','memory') ORDER BY kind,id LOOP
  source:=native_worklist_current(w,node.kind,node.id,frame);
  currents:=currents||jsonb_build_object(node.kind||':'||node.id,jsonb_build_object('kind',node.kind,'id',node.id,'source',source));
 END LOOP;
 IF application_native_worklist_helpers_current() IS NOT TRUE OR native_worklist_context(w,nodes) IS DISTINCT FROM context THEN RETURN NULL;END IF;
 RETURN jsonb_set(frame,'{currents}',currents);
END $$;
CREATE FUNCTION native_worklist_lineage(w uuid,kinds text[],ids uuid[],versions text[],memo jsonb)
RETURNS TABLE(kind text,id uuid,version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame jsonb:=memo->'nativeWorklist';
BEGIN
 IF (frame->>'workspaceId')=w::text AND (frame->>'closed')='true'
  AND kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL
  AND cardinality(kinds)=cardinality(ids) AND cardinality(ids)=cardinality(versions) AND cardinality(ids) BETWEEN 1 AND 100
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) root(k,i,v) WHERE NOT frame->'edges' ? (root.k||':'||root.i||':'||root.v)) THEN
  RETURN QUERY WITH RECURSIVE traversal(k,i,v) AS(
   SELECT * FROM unnest(kinds,ids,versions)
   UNION SELECT (child->>'kind'),((child->>'id'))::uuid,(child->>'version') FROM traversal parent
    CROSS JOIN LATERAL jsonb_array_elements(frame#>ARRAY['edges',parent.k||':'||parent.i||':'||parent.v]) child)
   SELECT parent.k,parent.i,parent.v FROM traversal parent;
 ELSE RETURN QUERY SELECT * FROM application_scope_lineage(w,kinds,ids,versions);END IF;
END $$;
CREATE FUNCTION native_worklist_snapshot(w uuid,k text,i uuid,v text,memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame jsonb:=memo->'nativeWorklist';entry jsonb;source jsonb;
BEGIN
 IF (frame->>'workspaceId')=w::text AND (frame->>'closed')='true' AND frame->'edges' ? (k||':'||i||':'||v) THEN
  entry:=frame#>ARRAY['currents',k||':'||i];
  IF entry IS NOT NULL THEN
   source:=entry->'source';
   IF source='null'::jsonb THEN RETURN NULL;END IF;
   IF (source->>'version')=v THEN RETURN source;END IF;
  END IF;
 END IF;
 -- Unknown candidates or versions retain the complete canonical reader.
 RETURN read_admitted_native_scope_snapshot(w,k,i);
END $$;
CREATE FUNCTION native_worklist_frame_current(w uuid,worklist_frame jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE node record;source jsonb;expected jsonb;nodes jsonb:=worklist_frame->'nodes';
BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 IF (worklist_frame->>'workspaceId') IS DISTINCT FROM w::text OR (worklist_frame->>'closed') IS DISTINCT FROM 'true'
  OR jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes) NOT BETWEEN 1 AND 4096
  OR native_worklist_context(w,nodes) IS DISTINCT FROM worklist_frame->'context'
  OR native_worklist_edges(w,nodes) IS DISTINCT FROM worklist_frame->'edges' THEN RETURN false;END IF;
 FOR node IN SELECT value FROM jsonb_each(worklist_frame->'currents') LOOP
  -- This independent canonical reader consumes neither the native snapshot
  -- worklist nor its Page/adjacency shortcuts.
  source:=read_admitted_native_scope_snapshot(w,(node.value->>'kind'),((node.value->>'id'))::uuid);
  expected:=node.value->'source';
  IF to_jsonb(source) IS DISTINCT FROM (CASE WHEN expected='null'::jsonb THEN NULL ELSE expected END) THEN RETURN false;END IF;
 END LOOP;
 IF native_worklist_edges(w,nodes) IS DISTINCT FROM worklist_frame->'edges'
  OR native_worklist_context(w,nodes) IS DISTINCT FROM worklist_frame->'context'
  OR application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN true;
END $$;
$definitions$;
 EXECUTE $definitions$CREATE FUNCTION public.native_worklist_current(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;
 IF k='knowledge_entry_revision' THEN
  IF knowledge_revision_scope_allowed(w,i) IS NOT TRUE THEN RETURN NULL;END IF;
  RETURN read_scope_source(w,k,i);
 END IF;
 RETURN native_worklist_current_knowledge_versions(w,k,i,worklist_frame);
END $function$;

CREATE FUNCTION public.native_worklist_current_application_sources(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF actor IS NULL OR k='external_source' OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
    OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';
 END IF;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL THEN RETURN NULL; END IF;
 IF NOT snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','version','held','validTo','retractedAt']
  OR jsonb_typeof(snapshot->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(snapshot->'projectIds') IS DISTINCT FROM 'array'
  OR jsonb_typeof(snapshot->'version') IS DISTINCT FROM 'string' OR length(snapshot->>'version')=0
  OR NOT coalesce(snapshot->>'sensitivity' IN('public','internal','confidential'),false)
  OR snapshot->>'workspaceId' IS DISTINCT FROM w::text OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(snapshot->>'userId')::uuid,(snapshot->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN '{"held":true}'::jsonb; END IF;
 -- Native retired rows retain D1 label judgement. Live rows must also pass the
 -- canonical source-specific parent/placement reader (files, sessions, pages, etc.).
 IF snapshot->>'validTo' IS NULL AND snapshot->>'retractedAt' IS NULL
  AND native_worklist_source(w,k,i,worklist_frame) IS NULL THEN RETURN '{"held":true}'::jsonb; END IF;
 RETURN jsonb_build_object('workspaceId',snapshot->'workspaceId','userId',snapshot->'userId','assistantId',snapshot->'assistantId',
  'sensitivity',snapshot->'sensitivity','compartments',snapshot->'compartments','projectIds',snapshot->'projectIds','version',snapshot->'version',
  'held',false,'validTo',snapshot->'validTo','retractedAt',snapshot->'retractedAt','causalEntityId',snapshot->'causalEntityId');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN '{"held":true}'::jsonb;
END $function$;

CREATE FUNCTION public.native_worklist_current_knowledge_versions(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF k='session_context_revision' THEN RETURN session_context_revision_native(w,i);END IF;
 RETURN native_worklist_current_persistent_context(w,k,i,worklist_frame);
END $function$;

CREATE FUNCTION public.native_worklist_current_persistent_context(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE source jsonb;type_key text;canonical_origin jsonb;
BEGIN
 IF nullif(current_setting('app.public_share_root',true),'') IS NULL THEN RETURN native_worklist_current_public_share(w,k,i,worklist_frame);END IF;
 IF application_public_share_allowed(w) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 IF k='entity' THEN SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=i AND e.kind IN('company','person','deal');canonical_origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='task' THEN type_key:='task';canonical_origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='entity_instance' THEN SELECT 'record.'||e.entity_type_id,jsonb_build_object('kind','generic','entityTypeId',e.entity_type_id) INTO type_key,canonical_origin FROM entity_instances e WHERE e.workspace_id=w AND e.id=i;
 ELSE RETURN '{"held":true}';END IF;
 IF type_key IS NULL OR EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=type_key) THEN RETURN '{"held":true}';END IF;
 source:=read_scope_source(w,k,i);
 IF source IS NULL THEN RETURN NULL;END IF;
 IF source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL OR application_public_scope_allowed(w,source) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN source;
END $function$;

CREATE FUNCTION public.native_worklist_current_public_share(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE snapshot jsonb;fields text[];
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN native_worklist_current_application_sources(w,k,i,worklist_frame);END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user
  AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN '{"held":true}';END IF;
 snapshot:=read_scope_source(w,k,i);fields:=application_native_source_fields(w,k,i);
 IF snapshot IS NULL THEN RETURN NULL;END IF;
 IF fields IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR scope_review_state_held(k,i)
  OR application_native_source_scope_allowed(w,k,i,snapshot,fields) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN snapshot;
END $function$;

CREATE FUNCTION public.native_worklist_source(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid;
 root jsonb;parent jsonb;context jsonb;policy jsonb;mask jsonb;feedback_message_id uuid;feedback_session_id uuid;expected text;
BEGIN
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;
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
  parent:=native_worklist_source(w,'session_message',feedback_message_id,worklist_frame);
  IF parent IS NULL OR parent->>'held' IS DISTINCT FROM 'false' OR parent->>'version' IS DISTINCT FROM expected
   OR application_session_query_parent(w,feedback_session_id) IS NULL THEN RETURN NULL;END IF;
  RETURN root||jsonb_build_object('requiredSources',coalesce(parent->'requiredSources','[]'::jsonb));
 END IF;
 -- Byte-identical current Memory retirement,8105external-source and fallback branches.
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN native_worklist_source_memory_successor(w,k,i,worklist_frame);
END $function$;

CREATE FUNCTION public.native_worklist_source_application_fields(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN k='workspace_file' AND EXISTS(SELECT 1 FROM workspace_files WHERE id=i AND workspace_id=w AND purpose='engineering_archive')
 THEN NULL ELSE native_worklist_source_engineering_archive(w,k,i,worklist_frame) END
$function$;

CREATE FUNCTION public.native_worklist_source_blueprint(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF k NOT IN('workflow_run','crm_event') THEN RETURN native_worklist_source_workflow_run(w,k,i,worklist_frame); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF k='crm_event' THEN
  snapshot:=read_scope_source(w,k,i);
  IF snapshot IS NULL OR crm_event_scope_allows(i,actor) IS NOT TRUE
   OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE
   OR native_worklist_source(w,'entity',(snapshot->>'causalEntityId')::uuid,worklist_frame) IS NULL THEN RETURN NULL; END IF;
  RETURN snapshot;
 END IF;
 snapshot:=workflow_derivation_snapshot(w,i);
 IF workflow_history_evidence_visible(i) IS NOT TRUE OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
EXCEPTION WHEN raise_exception OR invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $function$;

CREATE FUNCTION public.native_worklist_source_browser_profile(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s jsonb;
BEGIN
 s:=read_media_parent_snapshot(w,k,i);
 IF k IN('recording','episode','workspace_file') AND (s IS NULL OR s->>'held' IS DISTINCT FROM 'false'
  OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL OR scope_review_state_held(k,i)
  OR NOT media_parent_visible(k,i)) THEN RETURN NULL; END IF;
 RETURN s;
END $function$;

CREATE FUNCTION public.native_worklist_source_browser_session(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 v2 boolean; s jsonb; teams text[]; p browser_profiles;
BEGIN
 IF k<>'browser_profile' THEN RETURN native_worklist_source_browser_profile(w,k,i,worklist_frame); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
   AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
   AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 -- Lock the authority inputs before the canonical snapshot. Classification
 -- writers also start with the workspace lock, and the file writer holds it
 -- exclusively through commit.
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 s:=read_scope_source(w,k,i);
 IF s IS NULL OR s->>'held' IS DISTINCT FROM 'false'
  OR ((s->>'userId') IS NOT NULL AND (s->>'userId')::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM browser_profiles WHERE workspace_id=w AND id=i FOR SHARE;
 IF acting IS NOT NULL AND NOT acting=ANY(p.enabled_assistant_ids) THEN RETURN NULL; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
 IF v2 THEN
  IF department_row_allows(department_read_grants(),w,s->>'sensitivity',teams,(s->>'userId')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF member_operation_scope_allows(w,s->>'sensitivity',teams,false) IS NOT TRUE THEN RETURN NULL;
 END IF;
 IF agent_read_scope_allows(s->>'sensitivity',teams,'{}'::uuid[]) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN s;
END $function$;

CREATE FUNCTION public.native_worklist_source_capture(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s jsonb; actor uuid := nullif(current_setting('app.current_user_id',true),'')::uuid;
  teams text[]; projects uuid[]; visible jsonb;
BEGIN
  IF actor IS NULL OR k NOT IN ('entity','entity_link','episode','memory','knowledge_entry','kb_chunk','task','workspace_file')
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
    OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
      AND current_setting('app.agent_workspace_id',true)::uuid<>w) THEN RETURN NULL; END IF;
  s:=read_scope_source(w,k,i);
  IF s IS NULL OR ((s->>'userId') IS NOT NULL AND ((s->>'userId'))::uuid<>actor) THEN RETURN NULL; END IF;
  teams:=ARRAY(SELECT jsonb_array_elements_text((s->'compartments')));
  projects:=ARRAY(SELECT jsonb_array_elements_text((s->'projectIds'))::uuid);
  visible:=nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb;
  IF visible IS NOT NULL AND visible<>'null'::jsonb AND (s->>'assistantId') IS NOT NULL
    AND NOT visible ? ((s->>'assistantId')) THEN RETURN NULL; END IF;
  IF NOT member_operation_scope_allows(w,(s->>'sensitivity'),teams,false)
    OR NOT agent_read_scope_allows((s->>'sensitivity'),teams,projects) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM unnest(projects) pid WHERE NOT EXISTS(
    SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=pid AND pr.status='active'
      AND (EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor AND wm.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=pid AND pm.user_id=actor)))) THEN RETURN NULL; END IF;
  RETURN s;
END $function$;

CREATE FUNCTION public.native_worklist_source_conversation(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF k NOT IN ('entity','entity_link','episode','memory','knowledge_entry','kb_chunk','task','workspace_file')
  OR (SELECT department_read_v2 FROM workspaces WHERE id=w) IS NOT TRUE THEN RETURN native_worklist_source_primitive_v2(w,k,i,worklist_frame); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
END $function$;

CREATE FUNCTION public.native_worklist_source_engineering_archive(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb; source jsonb; admitted jsonb; dependencies jsonb; required jsonb:='[]';
BEGIN
 IF k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN RETURN read_page_derivation_source(w,k,i); END IF;
 result:=native_worklist_source_page(w,k,i,worklist_frame);
 IF result IS NULL THEN RETURN NULL; END IF;
 dependencies:=native_worklist_page_dependencies(w,k,i,result->>'version',worklist_frame);
 IF jsonb_array_length(dependencies)=0 THEN RETURN result; END IF;
 required:=coalesce(result->'requiredSources','[]');
 FOR source IN SELECT value FROM jsonb_array_elements(dependencies) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL; END IF;
  required:=required||jsonb_build_array(source)||(admitted->'requiredSources');
 END LOOP;
 RETURN result||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $function$;

CREATE FUNCTION public.native_worklist_source_knowledge_source_parent(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE root jsonb;source jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 IF k<>'session_context_revision' THEN RETURN native_worklist_source_persistent_context(w,k,i,worklist_frame);END IF;
 root:=session_context_revision_native(w,i);
 IF root->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(native_worklist_page_dependencies(w,k,i,'1',worklist_frame)) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(source)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $function$;

CREATE FUNCTION public.native_worklist_source_knowledge_versions(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;root jsonb;policy jsonb;dependency jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 IF k<>'knowledge_source' THEN RETURN native_worklist_source_knowledge_source_parent(w,k,i,worklist_frame);END IF;
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.workspace_knowledge_sources'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 root:=read_scope_source(w,k,i);
 IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR root->>'version' IS NULL
  OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL
  OR entity_derivation_envelope_valid(root) IS NOT TRUE OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(root->>'userId')::uuid,(root->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
 policy:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_source');
 IF policy->>'registered' IS DISTINCT FROM 'false' AND (policy->>'held' IS DISTINCT FROM 'false'
  OR read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_source') IS NULL) THEN RETURN NULL;END IF;
 -- Current Page obligations use the original canonical dependency readers.
 FOR dependency IN SELECT value FROM jsonb_array_elements(native_worklist_page_dependencies(w,k,i,root->>'version',worklist_frame)) LOOP
  admitted:=read_page_derivation_source(w,dependency->>'resourceKind',(dependency->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM dependency->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(dependency)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $function$;

CREATE FUNCTION public.native_worklist_source_memory_successor(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF k='knowledge_entry_revision' THEN RETURN native_worklist_current(w,k,i,worklist_frame);END IF;
 RETURN native_worklist_source_knowledge_versions(w,k,i,worklist_frame);
END $function$;

CREATE FUNCTION public.native_worklist_source_page(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 snapshot jsonb; parent sessions; member_role text; projects uuid[]; v2 boolean; forbidden_ancestry boolean;
BEGIN
 IF k<>'session_message' THEN RETURN native_worklist_source_conversation(w,k,i,worklist_frame); END IF;
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
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR scope_review_state_held(k,i)
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
 -- A transcript may retain an archive for audit, but cannot turn that
 -- archive into operational file input. Walk causal derivation receipts,
 -- including a segment's canonical file, rather than supersession ancestry.
 WITH RECURSIVE ancestry(kind,id) AS (
  SELECT k,i
  UNION
  SELECT next.kind,next.id FROM ancestry a CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id
    FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
    WHERE d.workspace_id=w AND d.resource_kind=a.kind AND d.resource_id=a.id
   UNION
   SELECT 'workspace_file',f.file_id FROM file_segments f
    WHERE a.kind='file_segment' AND f.workspace_id=w AND f.id=a.id
  ) next
 ) SELECT count(*)>4096 OR coalesce(bool_or(f.purpose='engineering_archive'),false)
   INTO forbidden_ancestry FROM (SELECT * FROM ancestry LIMIT 4097) a
   LEFT JOIN workspace_files f ON a.kind='workspace_file' AND f.workspace_id=w AND f.id=a.id;
 IF forbidden_ancestry THEN RETURN NULL; END IF;
 RETURN snapshot;
END $function$;

CREATE FUNCTION public.native_worklist_source_persistent_context(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF k IN('entity_instance','workspace_member') THEN RETURN application_admitted_native_metadata(w,k,i); END IF;
 IF k='application_field' THEN RETURN application_current_field_snapshot(w,i); END IF;
 RETURN native_worklist_source_application_fields(w,k,i,worklist_frame);
END $function$;

CREATE FUNCTION public.native_worklist_source_primitive_v2(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF k<>'blueprint_record' THEN RETURN native_worklist_source_blueprint(w,k,i,worklist_frame); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
END $function$;

CREATE FUNCTION public.native_worklist_source_recordings(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s jsonb;
BEGIN
 IF nullif(current_setting('app.programmatic_candidate_source',true),'') IS NULL THEN RETURN native_worklist_source_capture(w,k,i,worklist_frame); END IF;
 s:=programmatic_candidate_source();
 IF w::text IS DISTINCT FROM s->>'workspaceId' OR k<>'episode' OR i::text IS DISTINCT FROM (nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb)->'source'->>'resourceId' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 RETURN s;
END $function$;

CREATE FUNCTION public.native_worklist_source_workflow_run(w uuid, k text, i uuid, worklist_frame jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 v2 boolean; snapshot jsonb; s sessions; teams text[]; projects uuid[];
BEGIN
 IF k='browser_profile' THEN
  snapshot:=native_worklist_source_browser_session(w,k,i,worklist_frame);
  IF acting IS NOT NULL AND assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN snapshot;
 END IF;
 IF k<>'browser_session' THEN RETURN native_worklist_source_browser_session(w,k,i,worklist_frame); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
   AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
   AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF acting IS NOT NULL AND assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR (snapshot->>'userId')::uuid IS DISTINCT FROM actor THEN RETURN NULL; END IF;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 -- Workspace membership above supplies resolveAssistantAccess's membership
 -- leg; retain its additional canonical placement predicate too.
 IF assistant_placement_visible(actor,s.assistant_id) IS NOT TRUE THEN RETURN NULL; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 IF v2 THEN
  IF department_row_allows(department_read_grants(),w,snapshot->>'sensitivity',teams,actor) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF member_operation_scope_allows(w,snapshot->>'sensitivity',teams,false) IS NOT TRUE THEN RETURN NULL;
 END IF;
 IF agent_read_scope_allows(snapshot->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
END $function$;

CREATE FUNCTION public.native_worklist_eval_domain(w uuid, t text, i uuid, fields text[], memo jsonb)
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
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN jsonb_build_object('memo',memo);END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN jsonb_build_object('memo',memo);END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN jsonb_build_object('memo',memo);END IF;
 result:=native_worklist_eval_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo);
 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN jsonb_build_object('memo',memo);END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'memo',memo,'children',result->'children');
END $function$;

CREATE FUNCTION public.native_worklist_eval_envelope(w uuid, t text, i uuid, selection text, fields text[], memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF (t NOT IN('session_message','session_message_annotation') AND NOT(t='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) OR selection NOT IN('read','query','identity','query_domain') THEN RETURN jsonb_build_object('memo',memo);END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF t='memory' THEN
  state:=CASE WHEN selection='query_domain' THEN application_memory_statement_domain(w,i,keys,memo->'memoryStatement') ELSE application_memory_statement_state(w,i,keys,memo->'memoryStatement') END;
  IF state IS NULL THEN RETURN jsonb_build_object('memo',memo);END IF;
  RETURN jsonb_build_object('memo',memo,'value',application_memory_statement_envelope(w,origin,t,i,selection,NULL,keys,0,state));
 END IF;
 IF selection='query_domain' THEN result:=native_worklist_eval_domain(w,t,i,keys,memo);children:=coalesce(result->'children','[]'::jsonb);
 ELSE result:=native_worklist_eval_point_state(w,t,i,keys,memo);END IF;
 memo:=coalesce(result->'memo',memo);state:=result->'value';
 IF state IS NULL OR state='null'::jsonb THEN RETURN jsonb_build_object('memo',memo);END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 IF memo#>>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'value'] IS DISTINCT FROM 'true'
  OR memo#>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'external'] IS DISTINCT FROM '[]'::jsonb THEN
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN jsonb_build_object('memo',memo);END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $function$;

CREATE FUNCTION public.native_worklist_eval_field(w uuid, i uuid, v text, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';empty_capture jsonb;empty_lineage jsonb;empty_entry jsonb;
BEGIN
 -- Busy/cycle refusal precedes any worklist invalidation.
 IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF memo ? 'emptyQueries' THEN
  IF memo ? key THEN
   IF application_empty_query_helpers_current() IS NOT TRUE THEN
    memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
   ELSIF application_empty_query_worklist_current(w,memo) IS NOT TRUE THEN
    memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
   END IF;
  END IF;
  IF memo ? 'emptyQueries' AND (SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'-'memoryStatement'-'emptyQueries'))
   +(SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'->'emptyQueries'))>=4096 THEN
   memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
  END IF;
 END IF;
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' OR scope_review_state_held('application_field',i)
   OR application_session_eval_sources_current(w,memo#>ARRAY[key,'external']) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
  RETURN jsonb_build_object('memo',memo,'value',memo#>ARRAY[key,'value']);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'-'memoryStatement'))>=4096 OR scope_review_state_held('application_field',i) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF resource.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (resource.type_key NOT IN('session_message','session_message_annotation') AND NOT(resource.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) THEN
  current_source:=application_recorded_field_state_before_session_eval(w,i,v,0);
  IF current_source->>'held'='false' AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND resource.type_key IN('knowledge_entry','task','memory') AND resource.selection='query_domain' AND resource.selected_version IS NULL
   AND application_empty_query_helpers_current() IS TRUE
   AND (SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'-'memoryStatement'-'emptyQueries'))
    +(SELECT count(*) FROM jsonb_object_keys(coalesce(memo->'emptyQueries','{}')))<4095 THEN
   empty_capture:=application_recorded_field_root_capture(w,i,v,0);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO empty_lineage
    FROM native_worklist_lineage(w,ARRAY['application_field'],ARRAY[i],ARRAY[v],memo) n;
   IF empty_capture#>'{envelope,children}'='[]'::jsonb AND empty_capture#>'{envelope,sources}'='[]'::jsonb
    AND empty_capture#>>'{envelope,state,sourceKind}'='application_query_domain'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(empty_lineage) n
     WHERE NOT(n->>'kind'='application_field' AND n->>'id'=i::text AND n->>'version'=v
      OR n->>'kind'='application_query_domain' AND n->>'id'=resource.resource_id::text)) THEN
    empty_entry:=jsonb_build_object('workspaceId',w,'actor',current_setting('app.current_user_id',true),
     'id',i,'version',v,'capture',empty_capture,'state',current_source,'lineage',empty_lineage);
    IF memo#>ARRAY['emptyQueries',i::text||':'||v] IS NOT NULL
     AND memo#>ARRAY['emptyQueries',i::text||':'||v] IS DISTINCT FROM empty_entry THEN
     memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry
   WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
    END IF;
    memo:=jsonb_set(memo,'{emptyQueries}',coalesce(memo->'emptyQueries','{}')||jsonb_build_object(i::text||':'||v,empty_entry));
   END IF;
  END IF;
  RETURN jsonb_build_object('value',current_source,'memo',memo);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='session_messages'::regclass WHERE role.rolname=session_user
  AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=i AND version=v;
 IF NOT FOUND OR resource.selected_version IS NOT NULL THEN RETURN jsonb_build_object('memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 result:=native_worklist_eval_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo);
 memo:=coalesce(result->'memo',memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope->>'identity' IS DISTINCT FROM resource.identity OR (envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))
  OR workflow_evidence_envelope_visible(w,observation.source_scope) IS NOT TRUE OR workflow_evidence_envelope_visible(w,envelope->'source') IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=i AND version=v ORDER BY source_kind,source_id,source_version LOOP
  IF dependency.source_kind='application_field' THEN
   result:=native_worklist_eval_field(w,dependency.source_id,dependency.source_version,memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  ELSE current_source:=external_source_snapshot(w,dependency.source_id);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR dependency.source_kind='external_source' AND current_source->>'version' IS DISTINCT FROM dependency.source_version THEN RETURN jsonb_build_object('memo',memo);END IF;
 END LOOP;
 current_source:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',source->'resourceId','version',source->'version') ORDER BY source::text),'[]') INTO refs
  FROM jsonb_array_elements(envelope->'sources') source WHERE source->>'resourceKind'='external_source';
 IF EXISTS(SELECT 1 FROM native_worklist_lineage(w,ARRAY['application_field'],ARRAY[i],ARRAY[v],memo) n JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
   AND NOT coalesce(memo->'emptyQueries' ? (n.id::text||':'||n.version),false) AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',current_source,'external',refs)); END IF;RETURN jsonb_build_object('memo',memo,'value',current_source);
END $function$;

CREATE FUNCTION public.native_worklist_eval_point_state(w uuid, t text, i uuid, fields text[], memo jsonb)
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
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,'session_message',i) THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=native_worklist_snapshot(w,'session_message',i,m.scope_version::text,memo);
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
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM native_worklist_lineage(w,direct_kinds,direct_ids,direct_versions,memo) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=i) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM native_worklist_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]],memo) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

  END IF;
  IF history_shape IS TRUE THEN
   BEGIN
    IF application_reader_envelope_visible(w,source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     SELECT o.source_scope INTO immutable_scope FROM application_field_observations o
      WHERE o.workspace_id=w AND o.resource_id=direct_ids[direct_position] AND o.version=direct_versions[direct_position];
     IF immutable_scope IS NULL OR workflow_evidence_envelope_visible(w,immutable_scope) IS NOT TRUE
      OR sensitivity_rank(immutable_scope->>'sensitivity')>sensitivity_rank(source->>'sensitivity')
      OR NOT (source->'compartments')@>(immutable_scope->'compartments') OR NOT (source->'projectIds')@>(immutable_scope->'projectIds')
      OR immutable_scope->>'userId' IS NOT NULL AND immutable_scope->>'userId' IS DISTINCT FROM source->>'userId'
       AND (source->>'userId' IS NOT NULL OR immutable_scope->>'userId' IS DISTINCT FROM actor::text)
      THEN RETURN jsonb_build_object('memo',memo);END IF;
     IF EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
      projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]);
      IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
       OR projection->'root' IS DISTINCT FROM (immutable_scope||jsonb_build_object('resourceKind','application_field','resourceId',direct_ids[direct_position],'version',direct_versions[direct_position]))
       OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN RETURN jsonb_build_object('memo',memo);END IF;
      FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
       IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
      END LOOP;
     ELSE
      -- Ordinary originals retain their stricter exact current-version check.
      checked:=native_worklist_eval_field(w,direct_ids[direct_position],direct_versions[direct_position],memo);
      memo:=coalesce(checked->'memo',memo);admitted:=checked->'value';
      IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM direct_versions[direct_position]
       THEN RETURN jsonb_build_object('memo',memo);END IF;
     END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     -- The helper admits the complete originals after metadata discovery.
     -- Transitive ordinary fields retain D1; their immutable tuple is not rewritten.
     IF dependency.source IS NULL OR dependency.source->>'resourceKind' IS DISTINCT FROM 'application_field'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
      OR NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w
       AND o.resource_id=(dependency.source->>'resourceId')::uuid AND o.version=dependency.node_version)
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
     seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
     IF jsonb_array_length(seen)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT seen @> jsonb_build_array(jsonb_build_array(direct_ids[direct_position]::text,direct_versions[direct_position])) THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_external_source_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     admitted:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
     IF dependency.source IS NULL OR admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version OR admitted->>'version' IS DISTINCT FROM dependency.node_version
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE OR application_reader_envelope_visible(w,admitted) IS NOT TRUE
      THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    IF native_worklist_snapshot(w,'session_message',i,m.scope_version::text,memo) IS DISTINCT FROM source THEN RETURN jsonb_build_object('memo',memo);END IF;
   EXCEPTION WHEN insufficient_privilege THEN RETURN jsonb_build_object('memo',memo);END;
  ELSE
  checked:=native_worklist_eval_scope(w,'session_message',i,m.scope_version::text,memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
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
  checked:=native_worklist_eval_scope(w,'session_context_revision',revision.id,'1',memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  source:=session_context_revision_native(w,revision.id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$;

CREATE FUNCTION public.native_worklist_eval_scan(w uuid, s uuid, t text, through integer, fields text[], bounds jsonb, visibility jsonb, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL OR fields IS NULL
  OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN jsonb_build_object('memo',memo);END IF;
 FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  result:=native_worklist_eval_envelope(w,t,candidate.id,'query',fields,memo);memo:=coalesce(result->'memo',memo);point:=result->'value';
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

CREATE FUNCTION public.native_worklist_eval_scope(w uuid, k text, i uuid, v text, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE key text:='native:'||k||':'||i||':'||v;nodes jsonb;node jsonb;refs jsonb:='[]';current_source jsonb;result jsonb;dependency record;policy jsonb;mask jsonb;type_key text;
BEGIN
 IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 -- Only this evaluator consumes the extended namespace. The unchanged
 -- native-root snapshot evaluator cannot consume these completed entries.
 IF memo ? ('empty-'||key) THEN
  IF memo ? 'emptyQueries' THEN
   IF application_empty_query_helpers_current() IS TRUE THEN
    IF application_empty_query_worklist_current(w,memo) THEN
     RETURN jsonb_build_object('value',memo#>ARRAY['empty-'||key,'value']='true'::jsonb
      AND application_session_eval_sources_current(w,memo#>ARRAY['empty-'||key,'external']),'memo',memo);
    END IF;
   END IF;
  END IF;
  memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
 END IF;
 IF memo ? 'emptyQueries' AND (SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'-'memoryStatement'-'emptyQueries'))
  +(SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'->'emptyQueries'))>=4096 THEN memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement'); END IF;
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  RETURN jsonb_build_object('value',memo#>ARRAY[key,'value']='true'::jsonb AND application_session_eval_sources_current(w,memo#>ARRAY[key,'external']),'memo',memo);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo-'nativeWorklist'-'memoryStatement'))>=4096 THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO nodes FROM native_worklist_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v],memo) n;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='application_field' THEN
   result:=native_worklist_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=result->'memo';current_source:=result->'value';
   refs:=refs||coalesce(memo#>ARRAY['field:'||(node->>'id')||':'||(node->>'version'),'external'],'[]'::jsonb);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF node->>'kind'='external_source' THEN
   refs:=refs||jsonb_build_array(jsonb_build_object('id',node->'id','version',node->'version'));
   current_source:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version' THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF scope_source_table(node->>'kind') IS NOT NULL THEN
   IF node->>'kind'='session_context_revision' AND native_worklist_source(w,node->>'kind',(node->>'id')::uuid,memo->'nativeWorklist') IS NULL THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
   current_source:=native_worklist_snapshot(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);
   IF node->>'kind' IN('crm_event','session_context_revision') AND current_source IS NULL
    OR current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 END LOOP;
 -- An explicit raw entity source consumes the complete current field mask,
 -- unlike the selected native anchors of a field projection.
 FOR dependency IN SELECT DISTINCT edge.source_id FROM scope_derivation_sources edge JOIN scope_derivations d
  ON d.workspace_id=edge.workspace_id AND d.id=edge.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND edge.source_kind='entity' LOOP
  SELECT kind INTO type_key FROM entities WHERE workspace_id=w AND id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
    OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO refs FROM (SELECT DISTINCT value FROM jsonb_array_elements(refs)) unique_refs;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR (f.type_key NOT IN('session_message','session_message_annotation')
    AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
  memo:=memo-key;
  IF memo ? 'emptyQueries' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND NOT coalesce(memo->'emptyQueries' ? ((n->>'id')||':'||(n->>'version')),false)
    AND(f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR(f.type_key NOT IN('session_message','session_message_annotation')
     AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
   memo:=memo||jsonb_build_object('empty-'||key,jsonb_build_object('value',true,'external',refs));
  END IF;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
END $function$;
$definitions$;
 EXECUTE $definitions$CREATE FUNCTION public.read_native_file_worklist_evidence(w uuid, kinds text[], ids uuid[], versions text[], include_memory boolean, return_frame boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;worklist_frame jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;

 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 
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
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory','workspace_file')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory','workspace_file'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;

 -- Discover eligibility only. A file with its own derivation, any historical
 -- selector, or independent Page ancestry keeps the complete original path.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN scope_derivations d
   ON d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=(n->>'id')::uuid
   WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
   AND (f.selected_version IS NOT NULL OR f.selection='history')) THEN RETURN NULL;END IF;
 -- Decline an overfull graph before the original per-file Page walks.
 IF native_worklist_edges(w,nodes) IS NULL THEN RETURN NULL;END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='workspace_file' LOOP
  IF read_admitted_page_dependencies(w,'workspace_file',(node->>'id')::uuid,node->>'version')
   IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
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
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 IF return_frame AND memo#>>'{memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 worklist_frame:=native_worklist_seed(w,nodes);
 IF worklist_frame IS NULL THEN RETURN NULL;END IF;
 memo:=memo||jsonb_build_object('nativeWorklist',worklist_frame);
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=native_worklist_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory','workspace_file') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='session_context_revision' AND native_worklist_source(w,node->>'kind',(node->>'id')::uuid,worklist_frame) IS NULL THEN
   RETURN NULL;END IF;
  current_source:=native_worklist_snapshot(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN NULL;END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN NULL;END IF;
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
   RETURN NULL;END IF;
 END LOOP;
 -- The evaluator contract is also current at return.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO fresh_nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF nodes IS DISTINCT FROM fresh_nodes THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;

 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,fresh_nodes)) THEN RETURN NULL;END IF;
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
 
 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 IF native_worklist_frame_current(w,worklist_frame) IS NOT TRUE THEN RETURN NULL;END IF;
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 -- Native worklists are invocation-local. Only the original canonical memo
 -- entries may cross into the existing independently revalidated capture path.
 memo:=memo-'nativeWorklist';
 IF return_frame THEN RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents,'memo',memo,'lineage',fresh_nodes);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
EXCEPTION WHEN data_exception OR insufficient_privilege OR no_data_found THEN RETURN NULL;
 WHEN raise_exception THEN
  IF SQLERRM IN('page_ancestry_unavailable','scope_source_changed','scope_evidence_missing','scope_operation_denied','access_unavailable','scope_ancestry_unavailable') THEN RETURN NULL;END IF;
  RAISE;
END
$function$;
$definitions$;
 EXECUTE 'CREATE FUNCTION application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $stub$ BEGIN RETURN false;END $stub$';
 FOR row IN SELECT * FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('native_worklist_context','native_worklist_edges','native_worklist_page_dependencies','native_worklist_seed','native_worklist_lineage','native_worklist_snapshot','native_worklist_frame_current','native_worklist_current','native_worklist_current_application_sources','native_worklist_current_knowledge_versions','native_worklist_current_persistent_context','native_worklist_current_public_share','native_worklist_source','native_worklist_source_application_fields','native_worklist_source_blueprint','native_worklist_source_browser_profile','native_worklist_source_browser_session','native_worklist_source_capture','native_worklist_source_conversation','native_worklist_source_engineering_archive','native_worklist_source_knowledge_source_parent','native_worklist_source_knowledge_versions','native_worklist_source_memory_successor','native_worklist_source_page','native_worklist_source_persistent_context','native_worklist_source_primitive_v2','native_worklist_source_recordings','native_worklist_source_workflow_run','native_worklist_eval_domain','native_worklist_eval_envelope','native_worklist_eval_field','native_worklist_eval_point_state','native_worklist_eval_scan','native_worklist_eval_scope','read_native_file_worklist_evidence','application_native_worklist_helpers_current') LOOP
  FOR recipient IN SELECT DISTINCT a.grantee FROM aclexplode(coalesce(row.proacl,acldefault('f',row.proowner))) a WHERE a.grantee<>row.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',row.oid::regprocedure,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
  END LOOP;
 END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count FROM pg_proc p WHERE (pronamespace='public'::regnamespace AND proname IN('native_worklist_context','native_worklist_edges','native_worklist_page_dependencies','native_worklist_seed','native_worklist_lineage','native_worklist_snapshot','native_worklist_frame_current','native_worklist_current','native_worklist_current_application_sources','native_worklist_current_knowledge_versions','native_worklist_current_persistent_context','native_worklist_current_public_share','native_worklist_source','native_worklist_source_application_fields','native_worklist_source_blueprint','native_worklist_source_browser_profile','native_worklist_source_browser_session','native_worklist_source_capture','native_worklist_source_conversation','native_worklist_source_engineering_archive','native_worklist_source_knowledge_source_parent','native_worklist_source_knowledge_versions','native_worklist_source_memory_successor','native_worklist_source_page','native_worklist_source_persistent_context','native_worklist_source_primitive_v2','native_worklist_source_recordings','native_worklist_source_workflow_run','native_worklist_eval_domain','native_worklist_eval_envelope','native_worklist_eval_field','native_worklist_eval_point_state','native_worklist_eval_scan','native_worklist_eval_scope','read_native_file_worklist_evidence')) OR oid IN('application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'application_scope_source_edges(uuid,text,uuid,text)'::regprocedure,'application_session_eval_domain(uuid,text,uuid,text[],jsonb)'::regprocedure,'application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure,'application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure,'application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'::regprocedure,'application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure,'application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure,'read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_application_fields(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_blueprint(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_browser_profile(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_browser_session(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_capture(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_conversation(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_memory_successor(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_page(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_persistent_context(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_recordings(uuid,text,uuid)'::regprocedure,'read_entity_derivation_source_before_workflow_run(uuid,text,uuid)'::regprocedure,'read_resource_page_dependencies(uuid,text,uuid,text)'::regprocedure,'application_session_query_parent(uuid,uuid)'::regprocedure,'application_memory_query_context(uuid)'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,'application_memory_statement_helpers_current()'::regprocedure);
 body:='BEGIN
 IF (SELECT count(*)='||pin_count||' AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_empty_query_helpers_current();
 END';
 EXECUTE format('CREATE OR REPLACE FUNCTION application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO new_pin FROM pg_proc p WHERE oid='application_native_worklist_helpers_current()'::regprocedure;
 EXECUTE replace($wrappers$CREATE OR REPLACE FUNCTION public.read_native_file_session_evidence(w uuid, kinds text[], ids uuid[], versions text[], include_memory boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN

 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p WHERE p.oid='public.application_native_worklist_helpers_current()'::regprocedure)='__NATIVE_WORKLIST_GUARD_PIN__' THEN
 IF application_native_worklist_helpers_current() IS TRUE THEN
  DECLARE worklist_result jsonb;
  BEGIN
  worklist_result:=read_native_file_worklist_evidence(w,kinds,ids,versions,include_memory,false);
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p WHERE p.oid='public.application_native_worklist_helpers_current()'::regprocedure)='__NATIVE_WORKLIST_GUARD_PIN__' THEN
  IF worklist_result->>'admitted'='true' THEN RETURN worklist_result;END IF;
 END IF;
 END;
 END IF;
 END IF;

 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 
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
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory','workspace_file')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory','workspace_file'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;

 -- Discover eligibility only. A file with its own derivation, any historical
 -- selector, or independent Page ancestry keeps the complete original path.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN scope_derivations d
   ON d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=(n->>'id')::uuid
   WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
   AND (f.selected_version IS NOT NULL OR f.selection='history')) THEN RETURN NULL;END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='workspace_file' LOOP
  IF read_admitted_page_dependencies(w,'workspace_file',(node->>'id')::uuid,node->>'version')
   IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
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
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory','workspace_file') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
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
 
 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END $function$;

CREATE OR REPLACE FUNCTION public.read_native_file_session_cohort_frame(w uuid, kinds text[], ids uuid[], versions text[], include_memory boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN

 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p WHERE p.oid='public.application_native_worklist_helpers_current()'::regprocedure)='__NATIVE_WORKLIST_GUARD_PIN__' THEN
 IF application_native_worklist_helpers_current() IS TRUE THEN
  DECLARE worklist_result jsonb;
  BEGIN
  IF application_native_file_capture_helpers_current() IS TRUE THEN
  worklist_result:=read_native_file_worklist_evidence(w,kinds,ids,versions,include_memory,true);
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_catalog.pg_proc p WHERE p.oid='public.application_native_worklist_helpers_current()'::regprocedure)='__NATIVE_WORKLIST_GUARD_PIN__' THEN
  IF application_native_file_capture_helpers_current() IS TRUE AND worklist_result->>'admitted'='true' THEN RETURN worklist_result;END IF;
  END IF;
 END IF;
 END;
 END IF;
 END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;

 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 
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
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory','workspace_file')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory','workspace_file'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;

 -- Discover eligibility only. A file with its own derivation, any historical
 -- selector, or independent Page ancestry keeps the complete original path.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN scope_derivations d
   ON d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=(n->>'id')::uuid
   WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
   AND (f.selected_version IS NOT NULL OR f.selection='history')) THEN RETURN NULL;END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='workspace_file' LOOP
  IF read_admitted_page_dependencies(w,'workspace_file',(node->>'id')::uuid,node->>'version')
   IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
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
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory','workspace_file') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
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
 
 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents,'memo',memo,'lineage',fresh_nodes);

EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
 RAISE;
END $function$;
$wrappers$,'__NATIVE_WORKLIST_GUARD_PIN__',new_pin);
 old_pin:=original_pins->>'read_native_file_session_evidence';old_hash:=original_bodies->>'read_native_file_session_evidence';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('session_context_file_revision_allowed(uuid,uuid)'::regprocedure,'read_session_context_file_revision(uuid,uuid)'::regprocedure,'read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure,'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'application_native_title_group_helpers_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'read_native_file_session_cohort_frame';old_hash:=original_bodies->>'read_native_file_session_cohort_frame';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_native_file_capture_helpers_current()'::regprocedure,'application_native_dependency_batch_helpers_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'session_context_file_revision_allowed';old_hash:=original_bodies->>'session_context_file_revision_allowed';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='session_context_file_revision_allowed(uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'read_session_context_file_revision';old_hash:=original_bodies->>'read_session_context_file_revision';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_session_context_file_revision(uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'read_native_file_session_title_revision';old_hash:=original_bodies->>'read_native_file_session_title_revision';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'session_context_empty_query_revision_allowed';old_hash:=original_bodies->>'session_context_empty_query_revision_allowed';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'read_session_context_empty_query_revision';old_hash:=original_bodies->>'read_session_context_empty_query_revision';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_session_context_empty_query_revision(uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'read_native_empty_query_session_title_revision';old_hash:=original_bodies->>'read_native_empty_query_session_title_revision';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_empty_query_facades_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'application_native_file_capture_helpers_current';old_hash:=original_bodies->>'application_native_file_capture_helpers_current';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='application_native_file_capture_helpers_current()'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_native_dependency_batch_helpers_current()'::regprocedure,'application_native_field_reference_helpers_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 old_pin:=original_pins->>'application_native_dependency_batch_helpers_current';old_hash:=original_bodies->>'application_native_dependency_batch_helpers_current';
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO new_pin,new_hash FROM pg_proc p WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure;
 FOR row IN SELECT * FROM pg_proc WHERE oid IN('application_native_field_reference_helpers_current()'::regprocedure) LOOP
  body:=row.prosrc;
  IF strpos(body,old_pin)=0 AND strpos(body,old_hash)=0 THEN RAISE EXCEPTION 'Native worklist expected dependency pin missing: %',row.oid::regprocedure;END IF;
  body:=replace(replace(body,old_pin,new_pin),old_hash,new_hash);
  definition:=pg_get_functiondef(row.oid);EXECUTE replace(definition,row.prosrc,body);
 END LOOP;
 IF application_native_worklist_helpers_current() IS NOT TRUE OR application_native_file_capture_helpers_current() IS NOT TRUE
 OR application_native_dependency_batch_helpers_current() IS NOT TRUE OR application_native_field_reference_helpers_current() IS NOT TRUE
 OR application_empty_query_facades_current() IS NOT TRUE OR application_native_title_group_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'Native worklist final helper manifests changed';END IF;
END $install$;
SET LOCAL check_function_bodies=on;
COMMIT;
