-- [COMP:api/native-chat-read-cost] Finish explicit declared-media denial before generic ancestry replay.
-- Only canonical held:true can deny. Missing/unsupported/retired sources and fresh selector candidates retain fallback.
BEGIN;
DO $native_declared_media_hold$
DECLARE routine pg_proc;dependency pg_proc;target regprocedure;expected jsonb;entry_signature text;ok boolean;
 original text;normalized text;successor text;old_fingerprint text;new_fingerprint text;pins text:='';
 source_contract constant jsonb:=$hold_source_contract${"sha":"fb1131f4e9fc2e83caae8b672e2ba81c31041633fd9142d47de7b985d8303fc1","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_capture_sources","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","meta"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}}$hold_source_contract$::jsonb;
 compact_contract constant jsonb:=$hold_compact_contract${"sha":"c0dc161c6457f8e7fd63aebe0825f4e65744c96e2e56be6cf22dd1037d5ab364","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_capture_compact_requirements","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","roots","selectors"],"proargtypes":["2950","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}}$hold_compact_contract$::jsonb;
 old_source_before constant text:=$hold_old_source_before$
  IF n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' THEN
   canonical_source:=read_admitted_native_scope_snapshot(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid);
   IF canonical_source IS NULL OR canonical_source-ARRAY['causalEntityId'] IS DISTINCT FROM source-ARRAY['resourceKind','resourceId']
    OR read_entity_derivation_source(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid) IS NULL THEN RETURN NULL;END IF;
  END IF;
  IF m->>'exists' IS DISTINCT FROM 'true'$hold_old_source_before$;
 old_source_after constant text:=$hold_old_source_after$
  IF n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' THEN
   -- Canonical media admission dependency fence.
   IF (SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __MEDIA_PINS__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE
   THEN RETURN NULL;END IF;
   -- End canonical media admission dependency fence.
   canonical_source:=read_admitted_native_scope_snapshot(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid);
   IF canonical_source IS NULL OR canonical_source-ARRAY['causalEntityId'] IS DISTINCT FROM source-ARRAY['resourceKind','resourceId']
    OR read_entity_derivation_source(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid) IS NULL THEN RETURN NULL;END IF;
   -- Canonical media admission dependency fence.
   IF (SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __MEDIA_PINS__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE
   THEN RETURN NULL;END IF;
   -- End canonical media admission dependency fence.
  END IF;
  IF m->>'exists' IS DISTINCT FROM 'true'$hold_old_source_after$;
 declaration_before constant text:=$hold_declaration_before$source jsonb;canonical_source jsonb;$hold_declaration_before$;
 declaration_after constant text:=$hold_declaration_after$source jsonb;canonical_source jsonb;media_denied boolean:=false;$hold_declaration_after$;
 preflight_before constant text:=$hold_preflight_before$ SELECT coalesce(jsonb_object_agg((p->>'id'),native_turn_capture_parent(w,(p->>'id')::uuid)),'{}') INTO parents$hold_preflight_before$;
 preflight_after constant text:=$hold_preflight_after$ -- Only known holding candidates in immutable factual ancestry may short-circuit.
 -- Fresh selector candidates retain their existing filtering/fallback path.
 IF jsonb_typeof(meta->'declaredSourceKeys')='object' AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(meta#>'{witness,nativeMetadata}') item
  WHERE item#>>'{node,kind}' IN('workspace_file','episode','recording')
   AND meta->'declaredSourceKeys' ? ((item#>>'{node,kind}')||':'||(item#>>'{node,id}')||':'||(item#>>'{node,version}'))
    AND (item#>>'{metadata,held}'='true' OR scope_review_state_held(item#>>'{node,kind}',(item#>>'{node,id}')::uuid))) THEN
   -- Canonical media admission dependency fence.
   IF (SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __MEDIA_PINS__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE
   THEN RETURN NULL;END IF;
   -- End canonical media admission dependency fence.
  FOR n IN SELECT value FROM jsonb_array_elements(meta#>'{witness,nativeMetadata}') item
   WHERE item#>>'{node,kind}' IN('workspace_file','episode','recording')
    AND meta->'declaredSourceKeys' ? ((item#>>'{node,kind}')||':'||(item#>>'{node,id}')||':'||(item#>>'{node,version}'))
    AND (item#>>'{metadata,held}'='true' OR scope_review_state_held(item#>>'{node,kind}',(item#>>'{node,id}')::uuid)) LOOP
   canonical_source:=read_admitted_native_scope_snapshot(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid);
   media_denied:=media_denied OR coalesce(canonical_source->>'held'='true',false);
  END LOOP;
   -- Canonical media admission dependency fence.
   IF (SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __MEDIA_PINS__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE
   THEN RETURN NULL;END IF;
   -- End canonical media admission dependency fence.
  IF media_denied THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 SELECT coalesce(jsonb_object_agg((p->>'id'),native_turn_capture_parent(w,(p->>'id')::uuid)),'{}') INTO parents$hold_preflight_after$;
 compact_before constant text:=$hold_compact_before$ frame:=native_turn_capture_sources(w,meta);
 IF frame IS NULL OR frame->>'closed' IS DISTINCT FROM 'true' OR EXISTS(
 SELECT 1 FROM jsonb_each(frame->'currents') e WHERE e.value#>>'{source,held}' IS DISTINCT FROM 'false'
  OR e.value#>>'{source,validTo}' IS NOT NULL OR e.value#>>'{source,retractedAt}' IS NOT NULL)
 THEN RETURN jsonb_build_object('available',false,'reason','source_admission');END IF;
 WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
  SELECT value->'parent',value->'child' FROM jsonb_array_elements(meta#>'{witness,edges}')
  WHERE value->>'edge_kind' IN('derivation','observation','observation_child','predecessor')
 ), original(n) AS(
  SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots)
  UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
 ) SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO original_keys FROM original;
$hold_compact_before$;
 compact_after constant text:=$hold_compact_after$ WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
  SELECT value->'parent',value->'child' FROM jsonb_array_elements(meta#>'{witness,edges}')
  WHERE value->>'edge_kind' IN('derivation','observation','observation_child','predecessor')
 ), original(n) AS(
  SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots)
  UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
 ) SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO original_keys FROM original;
 frame:=native_turn_capture_sources(w,meta||jsonb_build_object('declaredSourceKeys',CASE WHEN selectors='[]'::jsonb THEN original_keys ELSE '{}'::jsonb END));
 IF frame IS NULL OR frame->>'closed' IS DISTINCT FROM 'true' OR EXISTS(
 SELECT 1 FROM jsonb_each(frame->'currents') e WHERE e.value#>>'{source,held}' IS DISTINCT FROM 'false'
  OR e.value#>>'{source,validTo}' IS NOT NULL OR e.value#>>'{source,retractedAt}' IS NOT NULL)
 THEN RETURN jsonb_build_object('available',false,'reason','source_admission');END IF;
$hold_compact_after$;
BEGIN
 FOREACH entry_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||entry_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_declared_media_contract_changed: %',entry_signature;END IF;
 END LOOP;
 FOR expected IN SELECT value FROM jsonb_array_elements($hold_dependencies$[{"signature":"file_session_binding_allows(uuid)","sha":"fa4464861d50f6e69a373116ba0fdcd8f14cd5e6a560e53e66c361dcc43ff9b2","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"file_session_binding_allows","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["file"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"media_parent_visible(text,uuid)","sha":"f762cd69224250421fa84d79be8038f30f5f9be49a505441eb08154ec7843ffd","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"media_parent_visible","prorows":0,"pronargs":2,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["k","i"],"proargtypes":["25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"office_output_file_allows(uuid,boolean)","sha":"5cc29b73c824cc701bba52cd60117eb95b4394f13c35d792d6f59b9cb032d02a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"office_output_file_allows","prorows":0,"pronargs":2,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["f","mutation"],"proargtypes":["2950","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"pdf_intake_file_visible(uuid)","sha":"4f91dad02ed9d3aa16b89f39c1900025a0119868fab21988fab526c132fb0672","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"pdf_intake_file_visible","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["file"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}},{"signature":"recording_transcript_file_allows(uuid)","sha":"29a942d9be233ed71004e733b19077d8f3ff7799774dd6363f309c5c62e5d37c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"recording_transcript_file_allows","prorows":0,"pronargs":1,"proconfig":["search_path=public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["i"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}}]$hold_dependencies$::jsonb) LOOP
  SELECT * INTO STRICT dependency FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF encode(sha256(convert_to(dependency.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'sha'
   OR (to_jsonb(dependency)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM expected->'metadata'
   OR dependency.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
   OR dependency.pronamespace<>'public'::regnamespace
   OR dependency.prolang<>(SELECT oid FROM pg_language WHERE lanname=CASE WHEN expected#>>'{metadata,proname}'='media_parent_visible' THEN 'plpgsql' ELSE 'sql' END)
   OR dependency.proargdefaults IS NOT NULL
   OR (SELECT count(*) IN(2,3) AND count(DISTINCT a.grantee)=count(*)
     AND coalesce(bool_and(a.grantor=dependency.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable
      AND a.grantee IN(0::oid,dependency.proowner,to_regrole('app_user')::oid)),false)
     AND coalesce(bool_or(a.grantee=dependency.proowner),false) AND coalesce(bool_or(a.grantee=0),false)
    FROM aclexplode(coalesce(dependency.proacl,acldefault('f',dependency.proowner))) a) IS NOT TRUE
  THEN RAISE EXCEPTION 'native_declared_media_dependency_changed: %',expected->>'signature';END IF;
  pins:=pins||CASE WHEN pins='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',dependency.oid,
    encode(sha256(convert_to(to_jsonb(dependency)::text,'UTF8')),'hex'));
 END LOOP;
 FOREACH entry_signature IN ARRAY ARRAY['native_turn_capture_sources(uuid,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)'] LOOP
  target:=to_regprocedure('public.'||entry_signature);SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
  expected:=CASE WHEN entry_signature='native_turn_capture_sources(uuid,jsonb)' THEN source_contract ELSE compact_contract END;
  original:=routine.prosrc;normalized:=original;
  IF entry_signature='native_turn_capture_sources(uuid,jsonb)' THEN
   IF (length(original)-length(replace(original,replace(old_source_after,'__MEDIA_PINS__',pins),'')))/length(replace(old_source_after,'__MEDIA_PINS__',pins))<>1
   THEN RAISE EXCEPTION 'native_declared_media_predecessor_changed: %',entry_signature;END IF;
   normalized:=replace(original,replace(old_source_after,'__MEDIA_PINS__',pins),old_source_before);
  END IF;
  old_fingerprint:=encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex');
  IF encode(sha256(convert_to(normalized,'UTF8')),'hex') IS DISTINCT FROM expected->>'sha'
   OR (to_jsonb(routine)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM expected->'metadata'
   OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
   OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR routine.proargdefaults IS NOT NULL
   OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=routine.proowner AND a.grantor=routine.proowner
     AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
    FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
   OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=entry_signature AND h.fingerprint=old_fingerprint)
  THEN RAISE EXCEPTION 'native_declared_media_predecessor_changed: %',entry_signature;END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
    position(quote_literal(original) IN p.prosrc)>0 OR position(old_fingerprint IN p.prosrc)>0
    OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
  THEN RAISE EXCEPTION 'native_declared_media_unexpected_pin_consumer: %',entry_signature;END IF;
  IF entry_signature='native_turn_capture_sources(uuid,jsonb)' THEN
   IF (length(original)-length(replace(original,declaration_before,'')))/length(declaration_before)<>1
    OR (length(original)-length(replace(original,preflight_before,'')))/length(preflight_before)<>1
   THEN RAISE EXCEPTION 'native_declared_media_splice_changed: %',entry_signature;END IF;
   successor:=replace(replace(original,declaration_before,declaration_after),preflight_before,replace(preflight_after,'__MEDIA_PINS__',pins));
  ELSE
   IF (length(original)-length(replace(original,compact_before,'')))/length(compact_before)<>1
   THEN RAISE EXCEPTION 'native_declared_media_splice_changed: %',entry_signature;END IF;
   successor:=replace(original,compact_before,compact_after);
  END IF;
  EXECUTE replace(pg_get_functiondef(target),original,successor);
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
   OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
  THEN RAISE EXCEPTION 'native_declared_media_metadata_changed: %',entry_signature;END IF;
  SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT new_fingerprint FROM pg_proc p WHERE oid=target;
  UPDATE native_turn_contract_helpers h SET fingerprint=new_fingerprint WHERE h.signature=entry_signature AND h.fingerprint=old_fingerprint;
  IF NOT FOUND THEN RAISE EXCEPTION 'native_declared_media_registry_changed: %',entry_signature;END IF;
 END LOOP;
 EXECUTE 'SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid' INTO ok;
 IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_declared_media_dependency_changed';END IF;
 FOREACH entry_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||entry_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_declared_media_successor_changed: %',entry_signature;END IF;
 END LOOP;
END $native_declared_media_hold$;
COMMIT;
