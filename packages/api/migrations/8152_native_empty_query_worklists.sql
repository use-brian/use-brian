BEGIN;
-- [COMP:api/application-persistence] Share closed native work without retaining
-- an empty-query permission across operations or skipping a current proof.
DO $prerequisites$
DECLARE required record;
BEGIN
 FOR required IN SELECT * FROM (VALUES
  ('application_session_eval_field(uuid,uuid,text,jsonb)','dfef37bfccf5ccb2f0258c83396fea6b735fcfe1563f36440198166d652d6ba4'),
  ('application_session_eval_scope(uuid,text,uuid,text,jsonb)','5e3d5c3a0e91bd7cb21c6c62d363f34920681e1dadc5cc2c91f3ae062e52c455'),
  ('application_field_envelope_ancestry_allowed(uuid,jsonb)','27143be754ab14cd8dd868df6da06a88cf784787b00e7093361f2a3702b2e62d'),
  ('read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','b5e7109655436be0bd985c9ef13f5f2bd556a6b513e4026a85d67c07da8193ac')
 ) expected(signature,body_sha) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(required.signature)) IS DISTINCT FROM required.body_sha THEN
   RAISE EXCEPTION 'Canonical empty-query prerequisite changed: %',required.signature;END IF;
 END LOOP;
 -- The two unmodified entry-point contracts must not acquire a new ACL,
 -- owner, configuration or execution mode merely because their body matches.
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN(
  'application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
  AND (p.proowner<>(SELECT proowner FROM pg_proc WHERE oid='application_memory_statement_helpers_current()'::regprocedure)
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR p.prokind<>'f'
   OR p.prosecdef IS NOT TRUE OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.proisstrict OR p.proleakproof OR p.proretset
   OR p.procost<>100 OR p.prorows<>0 OR p.provariadic<>0 OR p.prosupport<>0 OR p.pronargdefaults<>0
   OR p.proargdefaults IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL OR p.protrftypes IS NOT NULL
   OR p.probin IS NOT NULL OR p.prosqlbody IS NOT NULL
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR p.prorettype<>CASE p.proname WHEN 'application_field_envelope_ancestry_allowed' THEN 'boolean'::regtype ELSE 'jsonb'::regtype END
   OR p.proargnames IS DISTINCT FROM CASE p.proname WHEN 'application_field_envelope_ancestry_allowed' THEN ARRAY['w','envelope'] ELSE ARRAY['w','kinds','ids','versions','include_memory'] END
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantor<>p.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
     OR acl.grantee<>p.proowner AND NOT(p.proname='read_native_file_session_evidence'
      AND acl.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND acl.grantee<>0)))) THEN
  RAISE EXCEPTION 'Canonical empty-query entry metadata changed';END IF;
END $prerequisites$;

CREATE FUNCTION application_empty_query_worklist_reset(memo jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry
 WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement'
$$;
REVOKE ALL ON FUNCTION application_empty_query_worklist_reset(jsonb) FROM PUBLIC;

CREATE FUNCTION application_empty_query_worklist_current(w uuid,memo jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry record;capture jsonb;current_source jsonb;lineage jsonb;
BEGIN
 IF NOT memo ? 'emptyQueries' THEN RETURN true;END IF;
 IF application_empty_query_helpers_current() IS NOT TRUE OR jsonb_typeof(memo->'emptyQueries') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'-'emptyQueries'))
    +(SELECT count(*) FROM jsonb_object_keys(memo->'emptyQueries'))>4096 THEN RETURN false;END IF;
 FOR entry IN SELECT key,value FROM jsonb_each(memo->'emptyQueries') LOOP
  IF entry.value->>'workspaceId' IS DISTINCT FROM w::text
   OR entry.value->>'actor' IS DISTINCT FROM current_setting('app.current_user_id',true) THEN RETURN false;END IF;
  current_source:=application_recorded_field_state_before_session_eval(w,(entry.value->>'id')::uuid,entry.value->>'version',0);
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source IS DISTINCT FROM entry.value->'state' THEN RETURN false;END IF;
  capture:=application_recorded_field_root_capture(w,(entry.value->>'id')::uuid,entry.value->>'version',0);
  IF capture IS DISTINCT FROM entry.value->'capture' THEN RETURN false;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO lineage
   FROM application_scope_lineage(w,ARRAY['application_field'],ARRAY[(entry.value->>'id')::uuid],ARRAY[entry.value->>'version']) n;
  IF lineage IS DISTINCT FROM entry.value->'lineage' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_empty_query_worklist_current(uuid,jsonb) FROM PUBLIC;

DO $rewrite$
DECLARE original text;definition text;updated text;guard text;before_hash text;after_hash text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
  INTO original,definition,before_hash FROM pg_proc p WHERE oid='application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure;
 SELECT pg_get_functiondef('application_memory_statement_helpers_current()'::regprocedure) INTO guard;
 updated:=original;
 IF length(updated)-length(replace(updated,$before0$DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';
$before0$,''))<>length($before0$DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';
$before0$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before0$DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';
$before0$,$after0$DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';empty_capture jsonb;empty_lineage jsonb;empty_entry jsonb;
$after0$);
 IF length(updated)-length(replace(updated,$before1$ IF memo ? key THEN
$before1$,''))<>length($before1$ IF memo ? key THEN
$before1$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before1$ IF memo ? key THEN
$before1$,$after1$ -- Busy/cycle refusal precedes any worklist invalidation.
 IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF memo ? 'emptyQueries' THEN
  IF memo ? key THEN
   IF application_empty_query_helpers_current() IS NOT TRUE THEN
    memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
   ELSIF application_empty_query_worklist_current(w,memo) IS NOT TRUE THEN
    memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
   END IF;
  END IF;
  IF memo ? 'emptyQueries' AND (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'-'emptyQueries'))
   +(SELECT count(*) FROM jsonb_object_keys(memo->'emptyQueries'))>=4096 THEN
   memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement');
  END IF;
 END IF;
 IF memo ? key THEN
$after1$);
 IF length(updated)-length(replace(updated,$before2$  RETURN jsonb_build_object('value',current_source,'memo',memo);
$before2$,''))<>length($before2$  RETURN jsonb_build_object('value',current_source,'memo',memo);
$before2$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before2$  RETURN jsonb_build_object('value',current_source,'memo',memo);
$before2$,$after2$  IF current_source->>'held'='false' AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND resource.type_key IN('knowledge_entry','task','memory') AND resource.selection='query_domain' AND resource.selected_version IS NULL
   AND application_empty_query_helpers_current() IS TRUE
   AND (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'-'emptyQueries'))
    +(SELECT count(*) FROM jsonb_object_keys(coalesce(memo->'emptyQueries','{}')))<4095 THEN
   empty_capture:=application_recorded_field_root_capture(w,i,v,0);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO empty_lineage
    FROM application_scope_lineage(w,ARRAY['application_field'],ARRAY[i],ARRAY[v]) n;
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
$after2$);
 IF length(updated)-length(replace(updated,$before3$   AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
$before3$,''))<>length($before3$   AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
$before3$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before3$   AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
$before3$,$after3$   AND NOT coalesce(memo->'emptyQueries' ? (n.id::text||':'||n.version),false) AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
$after3$);
 EXECUTE replace(definition,original,updated);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO after_hash FROM pg_proc p WHERE oid='application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure;
 IF length(guard)-length(replace(guard,before_hash,''))<>length(before_hash) THEN RAISE EXCEPTION 'Canonical worklist manifest changed';END IF;
 EXECUTE replace(guard,before_hash,after_hash);
END $rewrite$;

DO $rewrite$
DECLARE original text;definition text;updated text;guard text;before_hash text;after_hash text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
  INTO original,definition,before_hash FROM pg_proc p WHERE oid='application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure;
 SELECT pg_get_functiondef('application_memory_statement_helpers_current()'::regprocedure) INTO guard;
 updated:=original;
 IF length(updated)-length(replace(updated,$before0$ IF memo ? key THEN
$before0$,''))<>length($before0$ IF memo ? key THEN
$before0$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before0$ IF memo ? key THEN
$before0$,$after0$ IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
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
 IF memo ? 'emptyQueries' AND (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'-'emptyQueries'))
  +(SELECT count(*) FROM jsonb_object_keys(memo->'emptyQueries'))>=4096 THEN memo:=(SELECT coalesce(jsonb_object_agg(entry.key,entry.value),'{}') FROM jsonb_each(memo) entry WHERE entry.value->>'busy'='true' OR entry.key='memoryStatement'); END IF;
 IF memo ? key THEN
$after0$);
 IF length(updated)-length(replace(updated,$before1$ ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
$before1$,''))<>length($before1$ ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
$before1$) THEN RAISE EXCEPTION 'Canonical worklist rewrite changed';END IF;
 updated:=replace(updated,$before1$ ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
$before1$,$after1$  IF memo ? 'emptyQueries' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND NOT coalesce(memo->'emptyQueries' ? ((n->>'id')||':'||(n->>'version')),false)
    AND(f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR(f.type_key NOT IN('session_message','session_message_annotation')
     AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
   memo:=memo||jsonb_build_object('empty-'||key,jsonb_build_object('value',true,'external',refs));
  END IF;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
$after1$);
 EXECUTE replace(definition,original,updated);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO after_hash FROM pg_proc p WHERE oid='application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure;
 IF length(guard)-length(replace(guard,before_hash,''))<>length(before_hash) THEN RAISE EXCEPTION 'Canonical worklist manifest changed';END IF;
 EXECUTE replace(guard,before_hash,after_hash);
END $rewrite$;

DO $cohort$
DECLARE original text;definition text;updated text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc
  WHERE oid='read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 updated:=replace(original,'fresh_nodes jsonb;','fresh_nodes jsonb;empty_capture jsonb;');
 updated:=overlay(updated placing E'BEGIN\n IF application_empty_query_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;\n'
  from position(E'BEGIN\n' IN updated) for length(E'BEGIN\n'));
 updated:=replace(updated,'include_memory AND field.type_key=''memory''',
  'include_memory AND field.type_key=''memory'' OR field.type_key IN(''knowledge_entry'',''task'') AND field.selection=''query_domain'' AND field.selected_version IS NULL');
 updated:=replace(updated,'include_memory AND f.type_key=''memory''',
  'include_memory AND f.type_key=''memory'' OR f.type_key IN(''knowledge_entry'',''task'') AND f.selection=''query_domain'' AND f.selected_version IS NULL');
 updated:=replace(updated,' -- Source-denied physical candidates', $eligibility$
 -- Preserve the original ancestry entry's recording privacy check for each
 -- batched root, including roots whose native D1 read would return NULL.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id) WHERE recording_source_read_allowed(w,root.kind,root.id) IS NOT TRUE) THEN RETURN NULL;END IF;
 -- Additional families enter only through a currently empty canonical domain.
 FOR node IN SELECT n FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key IN('knowledge_entry','task') LOOP
  empty_capture:=application_recorded_field_root_capture(w,(node->>'id')::uuid,node->>'version',0);
  IF empty_capture#>'{envelope,children}' IS DISTINCT FROM '[]'::jsonb
   OR empty_capture#>'{envelope,sources}' IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
 -- Source-denied physical candidates$eligibility$);
 updated:=replace(updated,$return$RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);$return$,
  $return$IF application_empty_query_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF application_empty_query_worklist_current(w,memo) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);$return$);
 -- A union of individually valid roots can exceed the aggregate bound. That
 -- is ineligible for batching, not a new denial of an original per-root proof.
 updated:=regexp_replace(updated,'END[[:space:]]*$', $exception$
EXCEPTION WHEN invalid_parameter_value THEN
 IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
 RAISE;
END $exception$);
 IF updated=original OR position('application_empty_query_helpers_current()' IN updated)=0 THEN RAISE EXCEPTION 'Empty-query cohort rewrite unavailable';END IF;
 definition:=replace(definition,original,updated);
 definition:=replace(definition,'CREATE OR REPLACE FUNCTION public.read_native_file_session_evidence(',
  'CREATE OR REPLACE FUNCTION public.read_native_empty_query_session_evidence(');
 EXECUTE definition;
END $cohort$;
REVOKE ALL ON FUNCTION read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean) FROM PUBLIC;

DO $ancestry$
DECLARE original text;definition text;updated text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc
  WHERE oid='application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure;
 updated:=replace(original,' IF envelope IS NULL THEN RETURN false;END IF;', $batch$
 IF envelope IS NULL THEN RETURN false;END IF;
 IF application_empty_query_helpers_current() IS TRUE
  AND envelope->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
  AND envelope->>'typeKey' IN('session_message','session_message_annotation') AND envelope->>'selection'='query_domain'
  AND envelope->>'selectedVersion' IS NULL AND envelope#>>'{state,sourceKind}'='application_query_domain'
  AND NOT EXISTS(WITH RECURSIVE envelopes(value) AS(
   SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value))
   SELECT 1 FROM envelopes WHERE value<>envelope AND (
    value->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
    AND value->>'typeKey' IN('session_message','session_message_annotation') AND value->>'selection' IN('read','query','identity')
    AND value->>'selectedVersion' IS NULL AND value#>>'{state,sourceKind}' IN('session_message','session_context_revision')
    AND pg_input_is_valid(value#>>'{state,sourceId}','uuid') AND value#>>'{state,sourceVersion}' IS NOT NULL) IS NOT TRUE) THEN
  WITH RECURSIVE envelopes(value) AS(
   SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value))
  SELECT array_agg(value#>>'{state,sourceKind}'),array_agg((value#>>'{state,sourceId}')::uuid),array_agg(value#>>'{state,sourceVersion}')
   INTO direct_kinds,direct_ids,direct_versions FROM envelopes WHERE value<>envelope;
  IF cardinality(direct_ids) BETWEEN 1 AND 100 THEN
   result:=read_native_empty_query_session_evidence(w,direct_kinds,direct_ids,direct_versions,true);
   IF result IS NOT NULL THEN RETURN result->>'admitted'='true';END IF;
  END IF;
 END IF;$batch$);
 updated:=replace(updated,E' ) SELECT value FROM envelopes LOOP\n', $point$
 ) SELECT value FROM envelopes LOOP
  IF application_empty_query_helpers_current() IS TRUE
   AND selected->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND selected->>'typeKey' IN('session_message','session_message_annotation')
   AND selected->>'selection' IN('read','query','identity') AND selected->>'selectedVersion' IS NULL
   AND selected#>>'{state,sourceKind}' IN('session_message','session_context_revision')
   AND pg_input_is_valid(selected#>>'{state,sourceId}','uuid') AND selected#>>'{state,sourceVersion}' IS NOT NULL THEN
   result:=read_native_empty_query_session_evidence(w,ARRAY[selected#>>'{state,sourceKind}'],
    ARRAY[(selected#>>'{state,sourceId}')::uuid],ARRAY[selected#>>'{state,sourceVersion}'],true);
   IF result IS NOT NULL THEN
    IF result->>'admitted' IS DISTINCT FROM 'true' THEN RETURN false;END IF;
    CONTINUE;
   END IF;
  END IF;
$point$);
 IF updated=original THEN RAISE EXCEPTION 'Empty-query ancestry rewrite unavailable';END IF;
 EXECUTE replace(definition,original,updated);
END $ancestry$;

-- Remove inherited default grants before pinning these private functions.
DO $private_acl$
DECLARE routine record;recipient record;
BEGIN
 FOR routine IN SELECT oid,oid::regprocedure signature,proowner,proacl FROM pg_proc WHERE oid IN('application_empty_query_worklist_reset(jsonb)'::regprocedure,'application_empty_query_worklist_current(uuid,jsonb)'::regprocedure,'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure) LOOP
  FOR recipient IN SELECT DISTINCT roles.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
   JOIN pg_roles roles ON roles.oid=acl.grantee WHERE acl.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
END $private_acl$;

-- Full current metadata, including owner, ACL, search_path and body. The
-- original127-helper manifest remains intact apart from the two reviewed
-- evaluator replacements above, preserving8150/8151 eligibility and fallback.
DO $guard$
DECLARE pins text;definition text;
BEGIN
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
  INTO pins FROM pg_proc p WHERE oid IN(
   'application_empty_query_worklist_reset(jsonb)'::regprocedure,
   'application_empty_query_worklist_current(uuid,jsonb)'::regprocedure,
   'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
   'application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure);
 definition:='CREATE FUNCTION application_empty_query_helpers_current() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(
  'SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)');
 EXECUTE definition;
END $guard$;
REVOKE ALL ON FUNCTION application_empty_query_helpers_current() FROM PUBLIC;
DO $private_acl$
DECLARE routine record;recipient record;
BEGIN
 FOR routine IN SELECT oid,oid::regprocedure signature,proowner,proacl FROM pg_proc WHERE oid IN('application_empty_query_helpers_current()'::regprocedure) LOOP
  FOR recipient IN SELECT DISTINCT roles.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
   JOIN pg_roles roles ON roles.oid=acl.grantee WHERE acl.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
END $private_acl$;

COMMIT;
