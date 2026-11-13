-- [COMP:api/native-chat-read-cost] Authenticate the newly reachable canonical media admission closure.
-- No permission predicates or grants change; dependency drift retains the existing unavailable result.
BEGIN;
DO $native_media_dependency$
DECLARE target regprocedure:='public.native_turn_capture_sources(uuid,jsonb)'::regprocedure;
 routine pg_proc;dependency pg_proc;expected jsonb;signature text;ok boolean;original text;successor text;
 old_fingerprint text;new_fingerprint text;pins text:='';before_text constant text:=$media_dependency_before$
  IF n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' THEN
   canonical_source:=read_admitted_native_scope_snapshot(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid);
   IF canonical_source IS NULL OR canonical_source-ARRAY['causalEntityId'] IS DISTINCT FROM source-ARRAY['resourceKind','resourceId']
    OR read_entity_derivation_source(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid) IS NULL THEN RETURN NULL;END IF;
  END IF;
  IF m->>'exists' IS DISTINCT FROM 'true'$media_dependency_before$;
 after_template constant text:=$media_dependency_after$
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
  IF m->>'exists' IS DISTINCT FROM 'true'$media_dependency_after$;
 target_contract constant jsonb:=$media_target_contract${"sha":"fb1131f4e9fc2e83caae8b672e2ba81c31041633fd9142d47de7b985d8303fc1","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"native_turn_capture_sources","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","meta"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proallargtypes":null,"pronargdefaults":0}}$media_target_contract$::jsonb;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_media_dependency_contract_changed: %',signature;END IF;
 END LOOP;
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
 original:=routine.prosrc;old_fingerprint:=encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex');
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM target_contract->>'sha'
  OR (to_jsonb(routine)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM target_contract->'metadata'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR routine.proargdefaults IS NOT NULL
  OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=routine.proowner AND a.grantor=routine.proowner
    AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
   FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature='native_turn_capture_sources(uuid,jsonb)' AND h.fingerprint=old_fingerprint)
 THEN RAISE EXCEPTION 'native_media_dependency_predecessor_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
   position(quote_literal(original) IN p.prosrc)>0 OR position(old_fingerprint IN p.prosrc)>0
   OR position(target_contract->>'sha' IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'native_media_dependency_unexpected_pin_consumer';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($media_dependencies$
[
 {
  "signature": "file_session_binding_allows(uuid)",
  "sha": "fa4464861d50f6e69a373116ba0fdcd8f14cd5e6a560e53e66c361dcc43ff9b2",
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "file_session_binding_allows",
   "prorows": 0,
   "pronargs": 1,
   "proconfig": [
    "search_path=public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "file"
   ],
   "proargtypes": [
    "2950"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "signature": "media_parent_visible(text,uuid)",
  "sha": "f762cd69224250421fa84d79be8038f30f5f9be49a505441eb08154ec7843ffd",
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "media_parent_visible",
   "prorows": 0,
   "pronargs": 2,
   "proconfig": [
    "search_path=public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "k",
    "i"
   ],
   "proargtypes": [
    "25",
    "2950"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "v",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "signature": "office_output_file_allows(uuid,boolean)",
  "sha": "5cc29b73c824cc701bba52cd60117eb95b4394f13c35d792d6f59b9cb032d02a",
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "office_output_file_allows",
   "prorows": 0,
   "pronargs": 2,
   "proconfig": [
    "search_path=public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "f",
    "mutation"
   ],
   "proargtypes": [
    "2950",
    "16"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "v",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "signature": "pdf_intake_file_visible(uuid)",
  "sha": "4f91dad02ed9d3aa16b89f39c1900025a0119868fab21988fab526c132fb0672",
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "pdf_intake_file_visible",
   "prorows": 0,
   "pronargs": 1,
   "proconfig": [
    "search_path=public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "file"
   ],
   "proargtypes": [
    "2950"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "signature": "recording_transcript_file_allows(uuid)",
  "sha": "29a942d9be233ed71004e733b19077d8f3ff7799774dd6363f309c5c62e5d37c",
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "recording_transcript_file_allows",
   "prorows": 0,
   "pronargs": 1,
   "proconfig": [
    "search_path=public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "i"
   ],
   "proargtypes": [
    "2950"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "v",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 }
]
$media_dependencies$::jsonb) LOOP
  SELECT * INTO STRICT dependency FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF encode(sha256(convert_to(dependency.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'sha'
   OR (to_jsonb(dependency)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM expected->'metadata'
   OR dependency.proowner<>routine.proowner OR dependency.pronamespace<>'public'::regnamespace
   OR dependency.prolang<>(SELECT oid FROM pg_language WHERE lanname=CASE WHEN expected#>>'{metadata,proname}'='media_parent_visible' THEN 'plpgsql' ELSE 'sql' END)
   OR dependency.proargdefaults IS NOT NULL
   OR (SELECT count(*) IN(2,3) AND count(DISTINCT a.grantee)=count(*)
     AND coalesce(bool_and(a.grantor=dependency.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable
      AND a.grantee IN(0::oid,dependency.proowner,to_regrole('app_user')::oid)),false)
     AND coalesce(bool_or(a.grantee=dependency.proowner),false) AND coalesce(bool_or(a.grantee=0),false)
    FROM aclexplode(coalesce(dependency.proacl,acldefault('f',dependency.proowner))) a) IS NOT TRUE
  THEN RAISE EXCEPTION 'native_media_admission_dependency_changed: %',expected->>'signature';END IF;
  pins:=pins||CASE WHEN pins='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',dependency.oid,
    encode(sha256(convert_to(to_jsonb(dependency)::text,'UTF8')),'hex'));
 END LOOP;
 IF (length(original)-length(replace(original,before_text,'')))/length(before_text)<>1
 THEN RAISE EXCEPTION 'native_media_dependency_splice_changed';END IF;
 successor:=replace(original,before_text,replace(after_template,'__MEDIA_PINS__',pins));
 EXECUTE replace(pg_get_functiondef(target),original,successor);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
  OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
 THEN RAISE EXCEPTION 'native_media_dependency_metadata_changed';END IF;
 EXECUTE 'SELECT count(*)=5 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid' INTO ok;
 IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_media_admission_dependency_changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT new_fingerprint FROM pg_proc p WHERE oid=target;
 UPDATE native_turn_contract_helpers h SET fingerprint=new_fingerprint WHERE h.signature='native_turn_capture_sources(uuid,jsonb)' AND h.fingerprint=old_fingerprint;
 IF NOT FOUND THEN RAISE EXCEPTION 'native_media_dependency_registry_changed';END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_media_dependency_successor_changed: %',signature;END IF;
 END LOOP;
END $native_media_dependency$;
COMMIT;
