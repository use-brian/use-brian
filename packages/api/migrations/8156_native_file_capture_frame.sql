BEGIN;
-- [COMP:api/application-persistence] Private file frames are consumed only
-- after a new complete proof; the existing generic fallback stays authoritative.
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
 THEN RAISE EXCEPTION 'File capture existing guard changed';END IF;
 IF application_empty_query_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'File capture canonical helpers changed';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"capture_native_session_projection_batch(uuid,uuid,integer,text)","body":"f4c353af08f7e5d635c92c46d45598fba4e9a6905dd1aef0efdbfc171d6432ee","runtime":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proargtypes":["2950","2950","23","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)","body":"b5e7109655436be0bd985c9ef13f5f2bd556a6b513e4026a85d67c07da8193ac","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_file_session_evidence","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions","include_memory"],"proargtypes":["2950","1009","2951","1009","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"body":"a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee","runtime":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proargtypes":["2950","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0},"signature":"read_native_session_field_snapshots(uuid,uuid[],text[])"}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
  IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM expected->'metadata'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) acl
    WHERE acl.grantor<>actual.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
     OR acl.grantee<>actual.proowner AND NOT((expected->>'runtime')::boolean
      AND acl.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND acl.grantee<>0)) THEN
   RAISE EXCEPTION 'File capture prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
END $prerequisites$;

DO $frame$
DECLARE original text;definition text;updated text;needle text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc
 WHERE oid='read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 needle:=' -- Read every original field under the current actor and original selector.';
 IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File frame eligibility splice changed';END IF;
 updated:=replace(original,needle,
  E' IF memo#>>''{memoryStatement,workspaceId}'' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;\n'||needle);
 needle:='RETURN jsonb_build_object(''admitted'',true,''immutable'',immutable,''current'',currents);';
 IF length(updated)-length(replace(updated,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File frame result splice changed';END IF;
 updated:=replace(updated,needle,
  E'IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;\n RETURN jsonb_build_object(''admitted'',true,''immutable'',immutable,''current'',currents,''memo'',memo,''lineage'',fresh_nodes);');
 updated:=overlay(updated placing E' IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;\n'
  from position(E'BEGIN\n' IN updated)+length(E'BEGIN\n') for 0);
 -- A fresh combined cohort can grow beyond the optional batch bound while
 -- its individual original roots remain valid. Preserve original fallback.
 updated:=regexp_replace(updated,'END[[:space:]]*$', $bounded$
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
 RAISE;
END $bounded$);
 definition:=replace(definition,original,updated);
 EXECUTE replace(definition,'CREATE OR REPLACE FUNCTION public.read_native_file_session_evidence(',
  'CREATE FUNCTION public.read_native_file_session_cohort_frame(');
END $frame$;

CREATE FUNCTION application_native_file_frame_current(w uuid,kinds text[],ids uuid[],versions text[],frame jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fresh jsonb;
BEGIN
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 IF frame->>'admitted' IS DISTINCT FROM 'true' OR frame#>>'{memo,memoryStatement,workspaceId}' IS DISTINCT FROM w::text
  OR jsonb_typeof(frame->'immutable') IS DISTINCT FROM 'array' OR jsonb_typeof(frame->'current') IS DISTINCT FROM 'array'
  OR jsonb_typeof(frame->'lineage') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 fresh:=read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
 RETURN fresh->>'admitted' IS NOT DISTINCT FROM 'true'
  AND fresh->'immutable' IS NOT DISTINCT FROM frame->'immutable'
  AND fresh->'current' IS NOT DISTINCT FROM frame->'current'
  AND fresh->'lineage' IS NOT DISTINCT FROM frame->'lineage'
  AND fresh#>'{memo,memoryStatement,context}' IS NOT DISTINCT FROM frame#>'{memo,memoryStatement,context}';
END $$;

DO $snapshots$
DECLARE original text;definition text;updated text;needle text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc
 WHERE oid='read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee' THEN
  RAISE EXCEPTION 'File snapshot prerequisite changed';END IF;
 updated:=replace(original,'DECLARE position integer;', 'DECLARE buffered jsonb:=''[]'';position integer;');
 updated:=overlay(updated placing E' IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN QUERY SELECT * FROM read_native_session_field_snapshots(w,ids,versions);RETURN;END IF;\n'
  from position(E'BEGIN\n' IN updated)+length(E'BEGIN\n') for 0);
 needle:='   frame_result:=read_native_session_cohort_frame(w,ARRAY(SELECT ''application_field''::text FROM unnest(ids)),ids,versions,true);';
 IF length(updated)-length(replace(updated,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File snapshot frame splice changed';END IF;
 updated:=replace(updated,needle,
  E'   IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN QUERY SELECT * FROM read_native_session_field_snapshots(w,ids,versions);RETURN;END IF;\n'
  ||'   frame_result:=read_native_file_session_cohort_frame(w,ARRAY(SELECT ''application_field''::text FROM unnest(ids)),ids,versions,true);');
 needle:=' FOR position IN 1..cardinality(ids) LOOP';
 IF length(updated)-length(replace(updated,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File snapshot loop splice changed';END IF;
 updated:=replace(updated,needle,
  E' IF frame_result->>''admitted'' IS DISTINCT FROM ''true'' OR memo#>>''{memoryStatement,workspaceId}'' IS DISTINCT FROM w::text THEN\n  RETURN QUERY SELECT * FROM read_native_session_field_snapshots(w,ids,versions);RETURN;\n END IF;\n'||needle);
 needle:='  ord:=position;RETURN NEXT;';
 IF length(updated)-length(replace(updated,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File snapshot buffer splice changed';END IF;
 updated:=replace(updated,needle,'  ord:=position;buffered:=buffered||jsonb_build_array(jsonb_build_object(''ord'',ord,''snapshot'',snapshot));');
 updated:=regexp_replace(updated,'END[[:space:]]*$', $finish$
 -- No seed proof from capture enters this function. Qualify these buffered
 -- snapshots with another complete proof belonging to this new invocation.
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN
  RETURN QUERY SELECT * FROM read_native_session_field_snapshots(w,ids,versions);RETURN;
 END IF;
 IF application_native_file_frame_current(w,ARRAY(SELECT 'application_field'::text FROM unnest(ids)),ids,versions,frame_result) IS NOT TRUE THEN
  RETURN QUERY SELECT * FROM read_native_session_field_snapshots(w,ids,versions);RETURN;
 END IF;
 RETURN QUERY SELECT (item->>'ord')::integer,item->'snapshot' FROM jsonb_array_elements(buffered) item ORDER BY (item->>'ord')::integer;
END $finish$);
 definition:=replace(definition,original,updated);
 EXECUTE replace(definition,'CREATE OR REPLACE FUNCTION public.read_native_session_field_snapshots(',
  'CREATE FUNCTION public.read_native_file_session_field_snapshots(');
END $snapshots$;

DO $capture$
DECLARE original text;definition text;updated text;before text;after text;metadata jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p
 WHERE oid='capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure;
 updated:=original;
 FOR before,after IN SELECT * FROM (VALUES
  ('frame_kind text;frame_id uuid;frame_version text;',
   'frame_kind text;frame_id uuid;frame_version text;file_frame boolean:=false;'),
  ('    frame_result:=read_native_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);',
$seed$    -- No-file captures retain their exact existing frame path and cost.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) n WHERE n->>'kind'='workspace_file') THEN
     IF application_native_file_capture_helpers_current() IS TRUE THEN
      frame_result:=read_native_file_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);
      file_frame:=frame_result->>'admitted'='true' AND frame_result#>>'{memo,memoryStatement,workspaceId}'=w::text;
     END IF;
    END IF;
    IF frame_result IS NULL THEN frame_result:=read_native_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);END IF;$seed$),
  (' IF frame_ancestry IS DISTINCT FROM true THEN',
   E' IF frame_ancestry IS DISTINCT FROM true THEN\n  IF file_frame THEN RETURN NULL;END IF;'),
  (' PERFORM application_materialize_field_envelope(w,envelope);',
$fresh$ -- Discard the entire buffered batch on a changed file frame. The outer
 -- projection reader then runs its unchanged generic capture from fresh data.
 IF file_frame THEN
  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  IF application_native_file_frame_current(w,frame_kinds,frame_ids,frame_versions,frame_result) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 PERFORM application_materialize_field_envelope(w,envelope);$fresh$),
  (' rows_json:=jsonb_build_array(jsonb_build_object(''row'',NULL,''sources'',jsonb_build_array(envelope->''source'')||(envelope->''sources'')));',
   E' IF file_frame THEN\n  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;\n END IF;\n rows_json:=jsonb_build_array(jsonb_build_object(''row'',NULL,''sources'',jsonb_build_array(envelope->''source'')||(envelope->''sources'')));')
 ) replacements(before_text,after_text) LOOP
  IF length(updated)-length(replace(updated,before,''))<>length(before) THEN RAISE EXCEPTION 'File capture consumption splice changed';END IF;
  updated:=replace(updated,before,after);
 END LOOP;
 EXECUTE replace(definition,original,updated);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'File capture authority metadata changed';END IF;
END $capture$;

DO $snapshot_boundary$
DECLARE original text;definition text;needle text;replacement text;metadata jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p
 WHERE oid='capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure;
 needle:=$loop$ FOR snap IN SELECT * FROM read_native_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;$loop$;
 IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'File snapshot boundary splice changed';END IF;
 replacement:=E' IF file_frame THEN\n  IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;\n'
  ||replace(needle,'read_native_session_field_snapshots(', 'read_native_file_session_field_snapshots(')
  ||E'\n ELSE\n'||needle||E'\n END IF;';
 EXECUTE replace(definition,original,replace(original,needle,replacement));
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'File snapshot boundary authority changed';END IF;
END $snapshot_boundary$;

DO $acl$
DECLARE routine record;recipient record;
BEGIN
 FOR routine IN SELECT oid::regprocedure signature,proowner,proacl FROM pg_proc WHERE oid IN(
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
  'read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine.signature);
  FOR recipient IN SELECT DISTINCT r.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
END $acl$;

DO $guard$
DECLARE pins text;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
  'read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure,
  'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 EXECUTE 'CREATE FUNCTION application_native_file_capture_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(
  'BEGIN
   IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END');
END $guard$;
REVOKE ALL ON FUNCTION application_native_file_capture_helpers_current() FROM PUBLIC;
DO $acl$
DECLARE recipient record;
BEGIN
 FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='application_native_file_capture_helpers_current()'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION application_native_file_capture_helpers_current() FROM %I',recipient.rolname);
 END LOOP;
END $acl$;
DO $$ BEGIN
 IF application_memory_statement_helpers_current() IS NOT TRUE OR application_empty_query_helpers_current() IS NOT TRUE
  OR application_native_file_capture_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'File capture helper compatibility changed';END IF;
END $$;
COMMIT;
