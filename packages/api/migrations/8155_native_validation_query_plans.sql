BEGIN;
-- [COMP:api/application-persistence] Equivalent query plans for canonical proofs.
-- No source, principal or ancestry result survives its original operation.
DO $prerequisites$
DECLARE expected jsonb;actual pg_proc;body text;
BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"application_memory_statement_helpers_current()","language":"sql","body":"66d7a595ae8e36f06747e34c8b0a2c377d407d76deb33e860140837166c87f39","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_statement_helpers_current","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"runtime":false,"normalized":true},{"signature":"recording_source_read_allowed(uuid,text,uuid)","language":"sql","body":"49e2306c14f42e4f20c174fbf65c88eb788faa2da5546a87771c5b6b7db430ff","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_source_read_allowed","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0},"runtime":true,"normalized":false},{"signature":"scope_source_ancestors_before_browser_profile(uuid,text,uuid)","language":"plpgsql","body":"401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors_before_browser_profile","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["p_workspace","p_kind","p_id","resource_id"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0},"runtime":false,"normalized":false}]$expected$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
  body:=actual.prosrc;
  IF (expected->>'normalized')::boolean THEN
   body:=regexp_replace(body,'\([0-9]+::oid,''[0-9a-f]{64}''::text\)',
    '(0::oid,''0000000000000000000000000000000000000000000000000000000000000000''::text)','g');
   body:=regexp_replace(body,'[0-9]+::oid','0::oid','g');
  END IF;
  IF actual.oid IS NULL OR encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM expected->'metadata'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) acl
    WHERE acl.grantor<>actual.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
     OR acl.grantee<>actual.proowner AND NOT((expected->>'runtime')::boolean
      AND acl.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND acl.grantee<>0)) THEN
   RAISE EXCEPTION 'Native query-plan prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
 IF application_memory_statement_helpers_current() IS NOT TRUE OR application_empty_query_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native query-plan canonical helpers changed';END IF;
END $prerequisites$;

DO $patch$
DECLARE original text;definition text;updated text;prior text;later text;guard text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO original,definition,prior
 FROM pg_proc p WHERE oid='recording_source_read_allowed(uuid,text,uuid)'::regprocedure;
 updated:=replace(original,'), parents AS (','), parents AS MATERIALIZED (');
 IF updated=original THEN RAISE EXCEPTION 'Recording parent splice changed';END IF;
 EXECUTE replace(definition,original,updated);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO later FROM pg_proc p WHERE oid='recording_source_read_allowed(uuid,text,uuid)'::regprocedure;
 SELECT pg_get_functiondef('application_memory_statement_helpers_current()'::regprocedure) INTO guard;
 IF position(prior IN guard)>0 THEN EXECUTE replace(guard,prior,later);END IF;
END $patch$;

DO $patch$
DECLARE original text;definition text;updated text;prior text;later text;guard text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO original,definition,prior
 FROM pg_proc p WHERE oid='scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure;
 updated:=replace(original,'  IF NOT versioned THEN', $static$
  -- Retain the live canonical mapping and column-shape decision above.
  -- Schema changes or a replacement mapping use the original dynamic branch.
  IF p_kind='workspace_file' AND tab='workspace_files' AND versioned THEN
    RETURN QUERY WITH RECURSIVE ancestry(id) AS (
      SELECT id FROM workspace_files WHERE workspace_id=p_workspace AND id=p_id
      UNION SELECT r.id FROM workspace_files r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=p_workspace
    ) SELECT id FROM ancestry;
    RETURN;
  END IF;
  IF NOT versioned THEN$static$);
 IF updated=original THEN RAISE EXCEPTION 'File predecessor splice changed';END IF;
 EXECUTE replace(definition,original,updated);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO later
 FROM pg_proc p WHERE oid='scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure;
 SELECT pg_get_functiondef('application_memory_statement_helpers_current()'::regprocedure) INTO guard;
 IF length(guard)-length(replace(guard,prior,''))<>length(prior) THEN RAISE EXCEPTION 'File predecessor manifest changed';END IF;
 EXECUTE replace(guard,prior,later);
END $patch$;

DO $patch$
DECLARE original text;definition text;manifest_oids oid[];columns_sql text;row_sql text;comparisons text;rows_sql text;shape jsonb;body text;captured_valid boolean;capture_guard text;metadata jsonb;
BEGIN
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Canonical helpers unavailable';END IF;
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-ARRAY['prosrc','prolang'] INTO original,definition,metadata FROM pg_proc p WHERE oid='application_memory_statement_helpers_current()'::regprocedure;
 SELECT array_agg(DISTINCT m[1]::oid ORDER BY m[1]::oid) INTO manifest_oids FROM regexp_matches(original,'[(]([0-9]+)::oid,''[0-9a-f]{64}''::text[)]','g') m;
 IF cardinality(manifest_oids)<>127 THEN RAISE EXCEPTION 'Unexpected helper manifest';END IF;
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
  string_agg(format('format(%L,%s)', '%L::'||CASE WHEN attname='proacl' THEN 'jsonb' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN 'text' ELSE format_type(atttypid,atttypmod) END,
   CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END),'||'',''||' ORDER BY attnum),
  string_agg(format('%s%s IS NOT DISTINCT FROM m.%I%s',CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END,attname,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END),' AND ' ORDER BY attnum),
  jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum)
 INTO columns_sql,row_sql,comparisons,shape
 FROM pg_attribute WHERE attrelid='pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 -- Validate the very same captured catalog tuples that become constants.
 -- A separate earlier guard call is not sufficient across a concurrent DDL.
 IF length(original)-length(replace(original,'JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid',''))
   <>length('JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid') THEN
  RAISE EXCEPTION 'Canonical manifest relation splice changed';END IF;
 capture_guard:=replace(original,'JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid','JOIN captured p ON p.oid=pin.function_oid');
 EXECUTE 'WITH captured AS MATERIALIZED(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)) '
  ||'SELECT ('||capture_guard||'),(SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM captured p)'
  INTO captured_valid,rows_sql USING manifest_oids;
 IF captured_valid IS NOT TRUE OR rows_sql IS NULL THEN RAISE EXCEPTION 'Captured canonical helper metadata changed';END IF;
 body:='BEGIN IF (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM '||quote_literal(shape::text)||'::jsonb THEN RETURN false;END IF; RETURN (SELECT count(*)=127 AND coalesce(bool_and('||comparisons||'),false) FROM (VALUES '||rows_sql||') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid);END';
 definition:=replace(definition,original,body);
 definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
 EXECUTE definition;
 IF (SELECT to_jsonb(p)-ARRAY['prosrc','prolang'] FROM pg_proc p WHERE oid='application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM metadata
  OR application_memory_statement_helpers_current() IS NOT TRUE OR application_empty_query_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Typed canonical manifest contract changed';END IF;
END $patch$;

COMMIT;
