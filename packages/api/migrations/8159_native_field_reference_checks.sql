BEGIN;
DO $prerequisites$
DECLARE expected jsonb;actual pg_proc;pins text;trusted text;
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
 IF application_empty_query_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native dependency canonical helpers changed';END IF;

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
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native dependency file helpers changed';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"body":"25028ddfeefca64f4d03d06785d6a17d10950910a66c0cf2c4a005ae0024c539","public":true,"runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_scope_resource_reference","prorows":0,"pronargs":0,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"validate_scope_resource_reference()"},{"body":"06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403","public":false,"runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_current_field_snapshot","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"application_current_field_snapshot(uuid,uuid)"},{"body":"318a98c7d1f20f7e590b53adef942d7a3b7dcdd273821e594116613172ccf37d","public":false,"runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_scope_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"read_scope_source(uuid,text,uuid)"},{"body":"68dc93ecfee1a416209fc464f4c4e50130f3a1618da988ad8a5daba1df9f93d1","public":false,"runtime":true,"language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_source_read_allowed","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"recording_source_read_allowed(uuid,text,uuid)"},{"body":"b5e7109655436be0bd985c9ef13f5f2bd556a6b513e4026a85d67c07da8193ac","public":false,"runtime":true,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proargtypes":["2950","1009","2951","1009","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)"},{"public":false,"runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_native_dependency_batch_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"signature":"application_native_dependency_batch_helpers_current()"}]$expected$::jsonb) LOOP
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
 IF actual.oid IS NULL OR (expected ? 'body' AND encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body')
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
 OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM expected->'metadata'
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
 WHERE a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
 OR a.grantee<>actual.proowner AND NOT((expected->>'public')::boolean AND a.grantee=0)
 AND NOT((expected->>'runtime')::boolean AND a.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND a.grantee<>0))
 THEN RAISE EXCEPTION 'Native field reference prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
END $prerequisites$;
DO $guard$
DECLARE pins text;pin_count integer;trigger_state jsonb;table_state jsonb;shape_sql text;body text;
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
 IF body IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure) THEN RAISE EXCEPTION 'Native field reference dependency guard changed';END IF;
 IF application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native field reference dependency helpers changed';END IF;
END $guard$;
DO $reference_fk$
DECLARE dependency_fk oid;
BEGIN
 SELECT oid INTO dependency_fk FROM pg_constraint c WHERE conrelid='public.scope_derivation_sources'::regclass
 AND conname='scope_derivation_sources_workspace_id_derivation_id_fkey' AND contype='f'
 AND confrelid='public.scope_derivations'::regclass AND convalidated AND NOT condeferrable AND NOT condeferred
 AND (to_jsonb(c)->>'conenforced') IS DISTINCT FROM 'false'
 AND pg_get_constraintdef(oid)='FOREIGN KEY (workspace_id, derivation_id) REFERENCES scope_derivations(workspace_id, id) ON DELETE CASCADE';
 IF dependency_fk IS NULL OR (SELECT count(*) FROM pg_trigger WHERE tgconstraint=dependency_fk)<>4
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgconstraint=dependency_fk AND(tgenabled<>'O' OR NOT tgisinternal OR tgdeferrable OR tginitdeferred))
 OR (SELECT count(DISTINCT expected.name) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
 JOIN (VALUES ('RI_FKey_check_ins',5,'scope_derivation_sources'),('RI_FKey_check_upd',17,'scope_derivation_sources'),
  ('RI_FKey_cascade_del',9,'scope_derivations'),('RI_FKey_noaction_upd',17,'scope_derivations')) expected(name,event_type,relation)
 ON p.proname=expected.name AND t.tgtype=expected.event_type AND t.tgrelid=to_regclass('public.'||expected.relation)
 WHERE t.tgconstraint=dependency_fk AND p.pronamespace='pg_catalog'::regnamespace
 AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='internal') AND p.prosrc=expected.name AND p.probin IS NULL)<>4
 THEN RAISE EXCEPTION 'Native field reference foreign key changed';END IF;
END $reference_fk$;
-- [COMP:api/application-persistence] Structural identity is not current admission.
CREATE FUNCTION read_native_field_reference_snapshot(w uuid,derivation uuid,field_id uuid,expected_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF application_native_field_reference_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF current_setting('app.crm_erasure_capture',true)='on'
 OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class t ON t.oid='public.scope_derivation_sources'::regclass
  WHERE r.rolname=session_user AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,t.relowner,'USAGE')))
 OR NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.id=derivation
  AND d.resource_kind IN('session_message','session_context_revision')
  AND d.xmin=(mod(txid_current(),4294967296)::text)::xid)
 OR NOT EXISTS(SELECT 1 FROM application_field_resources f JOIN application_field_observations o
  ON o.workspace_id=f.workspace_id AND o.resource_id=f.id
  WHERE f.workspace_id=w AND f.id=field_id AND o.version=expected_version
  AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
  AND f.type_key IN('session_message','session_message_annotation','memory')
  AND f.selection IN('read','query','identity','query_domain') AND f.selected_version IS NULL)
 THEN RETURN NULL;END IF;
 IF recording_source_read_allowed(w,'application_field',field_id) IS NOT TRUE THEN RETURN NULL;END IF;
 IF application_native_field_reference_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 -- Only the immediate reference predicate consumes this identity. The unchanged
 -- named constraint freshly validates current authorization before commit.
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','application_field','resourceId',field_id,'version',expected_version);
END $$;
CREATE FUNCTION application_native_field_reference_helpers_current() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RETURN false;END $$;
DO $reference$
DECLARE original text;definition text;old_fingerprint text;new_fingerprint text;guard text;metadata jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),to_jsonb(p)-'prosrc'
 INTO original,definition,old_fingerprint,metadata FROM pg_proc p WHERE oid='validate_scope_resource_reference()'::regprocedure;
 IF position($old$source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
    THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
    ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;$old$ IN original)=0 THEN RAISE EXCEPTION 'Native field reference lookup shape changed';END IF;
 definition:=replace(definition,$old$source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
    THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
    ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;$old$,$new$source_row:=NULL;
  IF TG_RELID='public.scope_derivation_sources'::regclass AND TG_OP='INSERT' AND expected_kind='application_field' THEN
    IF application_native_field_reference_helpers_current() IS TRUE THEN
      source_row:=read_native_field_reference_snapshot(NEW.workspace_id,NEW.derivation_id,expected_id,expected_version);
    END IF;
  END IF;
  IF source_row IS NULL THEN
    source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'
      THEN read_scope_review_source(NEW.workspace_id,expected_kind,expected_id)
      ELSE read_scope_source(NEW.workspace_id,expected_kind,expected_id) END;
  END IF;$new$);
 EXECUTE definition;
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='validate_scope_resource_reference()'::regprocedure) IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Native field reference metadata changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO new_fingerprint FROM pg_proc p WHERE oid='validate_scope_resource_reference()'::regprocedure;
 SELECT prosrc INTO guard FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure;
 IF (length(guard)-length(replace(guard,old_fingerprint,'')))/length(old_fingerprint)<>1 THEN RAISE EXCEPTION 'Native field reference dependency pin changed';END IF;
 EXECUTE replace(pg_get_functiondef('application_native_dependency_batch_helpers_current()'::regprocedure),old_fingerprint,new_fingerprint);
END $reference$;
DO $private_acl$
DECLARE routine record;recipient record;
BEGIN
 FOR routine IN SELECT p.oid,p.oid::regprocedure::text signature,p.proowner,p.proacl FROM pg_proc p
 WHERE p.oid IN('read_native_field_reference_snapshot(uuid,uuid,uuid,text)'::regprocedure,'application_native_field_reference_helpers_current()'::regprocedure) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine.signature);
  FOR recipient IN SELECT DISTINCT r.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
END $private_acl$;
DO $reference_guard$
DECLARE pins text;body text;fk_state jsonb;fk_query text;
BEGIN
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
 EXECUTE 'CREATE OR REPLACE FUNCTION application_native_field_reference_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(body);
 IF application_native_field_reference_helpers_current() IS NOT TRUE OR application_native_dependency_batch_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native field reference final guard failed';END IF;
END $reference_guard$;
COMMIT;
