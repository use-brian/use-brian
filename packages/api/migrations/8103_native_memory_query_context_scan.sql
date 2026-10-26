BEGIN;
-- [COMP:api/application-persistence] One canonical default-native context per scan.
-- Exact current canonical candidate checks remain private and unchanged.
DO $memory_query_context_clone$
DECLARE definition text;before text;routine pg_proc;created pg_proc;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure;
 definition:=pg_get_functiondef(routine.oid);
 before:='CREATE OR REPLACE FUNCTION public.application_memory_field_state_before_successor(w uuid, i uuid, fields text[])';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory context clone signature changed';END IF;
 definition:=replace(definition,before,'CREATE OR REPLACE FUNCTION public.application_memory_query_candidate_state(w uuid, i uuid, fields text[], admitted_context jsonb)');
 before:='context:=application_memory_query_context(w);';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory context clone reader changed';END IF;
 definition:=replace(definition,before,'context:=admitted_context;');
 EXECUTE definition;
 EXECUTE format('ALTER FUNCTION public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb) OWNER TO %I',pg_get_userbyid(routine.proowner));
 REVOKE ALL ON FUNCTION public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb) FROM app_user;END IF;
 SELECT * INTO STRICT created FROM pg_proc WHERE oid='public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure;
 IF created.proowner IS DISTINCT FROM routine.proowner OR created.prosecdef IS DISTINCT FROM routine.prosecdef
  OR created.proconfig IS DISTINCT FROM routine.proconfig OR created.prolang IS DISTINCT FROM routine.prolang
  OR created.provolatile IS DISTINCT FROM routine.provolatile OR created.proparallel IS DISTINCT FROM routine.proparallel THEN
  RAISE EXCEPTION 'Memory context clone metadata changed';END IF;
END $memory_query_context_clone$;

DO $memory_query_context_scans$
DECLARE signature text;definition text;before text;metadata jsonb;actual_metadata jsonb;
BEGIN
 FOREACH signature IN ARRAY ARRAY['application_memory_query_scan(uuid,text[],jsonb,boolean)',
  'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'] LOOP
  SELECT to_jsonb(p)-'prosrc' INTO metadata FROM pg_proc p WHERE p.oid=signature::regprocedure;
  definition:=pg_get_functiondef(signature::regprocedure);
  before:='DECLARE candidate record;state jsonb;';
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory scan variables changed: %',signature;END IF;
  definition:=replace(definition,before,'DECLARE candidate record;state jsonb;query_context jsonb;shared_context boolean:=false;');
  before:=$before$IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR application_query_scope_valid(bounds) IS NOT TRUE OR include_retained IS NULL THEN RETURN NULL;END IF;$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory scan validation changed: %',signature;END IF;
  definition:=replace(definition,before,before||$after$
 -- Keep unsupported profiles on the unchanged per-candidate canonical reader.
 -- An acquisition failure rolls back only these optional new locks. The old
 -- canonical source read may keep its original wait; this is not a no-wait RPC.
 BEGIN
  PERFORM id FROM workspaces WHERE id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'native_memory_scan_context_unavailable' USING ERRCODE='55P03';END IF;
  PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'native_memory_scan_context_unavailable' USING ERRCODE='55P03';END IF;
  PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'native_memory_scan_context_unavailable' USING ERRCODE='55P03';END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc canonical_proc JOIN pg_proc candidate_proc
   ON candidate_proc.oid='public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure
   WHERE canonical_proc.oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure
    AND array_length(string_to_array(canonical_proc.prosrc,'context:=application_memory_query_context(w);'),1)=2
    AND candidate_proc.prosrc=replace(canonical_proc.prosrc,'context:=application_memory_query_context(w);','context:=admitted_context;')
    AND ROW(candidate_proc.proowner,candidate_proc.prosecdef,candidate_proc.proconfig,candidate_proc.prolang,candidate_proc.provolatile,candidate_proc.proparallel,candidate_proc.proisstrict,candidate_proc.prorettype,candidate_proc.proretset,candidate_proc.prokind,candidate_proc.proleakproof)
     IS NOT DISTINCT FROM ROW(canonical_proc.proowner,canonical_proc.prosecdef,canonical_proc.proconfig,canonical_proc.prolang,canonical_proc.provolatile,canonical_proc.proparallel,canonical_proc.proisstrict,canonical_proc.prorettype,canonical_proc.proretset,canonical_proc.prokind,canonical_proc.proleakproof)) THEN
   RAISE EXCEPTION 'native_memory_scan_context_unavailable' USING ERRCODE='55P03';END IF;
  query_context:=application_memory_query_context(w);
  IF query_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'native_memory_scan_context_unavailable' USING ERRCODE='55P03';END IF;
  shared_context:=true;
 EXCEPTION WHEN lock_not_available THEN shared_context:=false;query_context:=NULL;
 END;$after$);
  before:='state:=application_memory_field_state(w,candidate.id,fields);';
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory scan candidate changed: %',signature;END IF;
  definition:=replace(definition,before,$after$IF shared_context AND NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=candidate.id AND valid_to IS NOT NULL) THEN
   state:=application_memory_query_candidate_state(w,candidate.id,fields,query_context);
  ELSE
   state:=application_memory_field_state(w,candidate.id,fields);
  END IF;$after$);
  before:=$before$RETURN jsonb_build_object('candidates',candidates,'policies',policies);$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory scan return changed: %',signature;END IF;
  definition:=replace(definition,before,$after$IF shared_context AND (NOT EXISTS(SELECT 1 FROM pg_proc canonical_proc JOIN pg_proc candidate_proc
   ON candidate_proc.oid='public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure
   WHERE canonical_proc.oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure
    AND array_length(string_to_array(canonical_proc.prosrc,'context:=application_memory_query_context(w);'),1)=2
    AND candidate_proc.prosrc=replace(canonical_proc.prosrc,'context:=application_memory_query_context(w);','context:=admitted_context;')
    AND ROW(candidate_proc.proowner,candidate_proc.prosecdef,candidate_proc.proconfig,candidate_proc.prolang,candidate_proc.provolatile,candidate_proc.proparallel,candidate_proc.proisstrict,candidate_proc.prorettype,candidate_proc.proretset,candidate_proc.prokind,candidate_proc.proleakproof)
     IS NOT DISTINCT FROM ROW(canonical_proc.proowner,canonical_proc.prosecdef,canonical_proc.proconfig,canonical_proc.prolang,canonical_proc.provolatile,canonical_proc.proparallel,canonical_proc.proisstrict,canonical_proc.prorettype,canonical_proc.proretset,canonical_proc.prokind,canonical_proc.proleakproof))
  OR application_memory_query_context(w) IS DISTINCT FROM query_context) THEN RETURN NULL;END IF;
 $after$||before);
  EXECUTE definition;
  SELECT to_jsonb(p)-'prosrc' INTO actual_metadata FROM pg_proc p WHERE p.oid=signature::regprocedure;
  IF actual_metadata IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'Memory scan metadata changed: %',signature;END IF;
 END LOOP;
END $memory_query_context_scans$;
COMMIT;
