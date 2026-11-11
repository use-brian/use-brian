-- [COMP:api/native-chat-read-cost] Evaluate the canonical audience against its complete session row.
-- Retain the existing metadata projection and every recording/source boundary.
BEGIN;
DO $native_parent_audience$
DECLARE target regprocedure:='public.native_turn_parent_scope(uuid,uuid)'::regprocedure;
 routine pg_proc;original text;successor text;old_fingerprint text;new_fingerprint text;
 signature text;ok boolean;
 before_text constant text:=$before$
 SELECT id,workspace_id,assistant_id,user_id,visibility,context_group_id,context_project_id,context_compartments,effective_clearance INTO s.id,s.workspace_id,s.assistant_id,s.user_id,s.visibility,s.context_group_id,s.context_project_id,s.context_compartments,s.effective_clearance FROM sessions WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR NOT coalesce(session_personal_audience(s) OR session_workspace_audience(s),false)
  OR session_project_audience(s,false) IS NOT TRUE THEN RETURN NULL;END IF;$before$;
 after_text constant text:=$after$
 -- Audience predicates consume the actual complete row, including newly added
 -- policy inputs. Only the existing parent metadata is selected into local s.
 SELECT actual.id,actual.workspace_id,actual.assistant_id,actual.user_id,actual.visibility,
  actual.context_group_id,actual.context_project_id,actual.context_compartments,actual.effective_clearance
 INTO s.id,s.workspace_id,s.assistant_id,s.user_id,s.visibility,
  s.context_group_id,s.context_project_id,s.context_compartments,s.effective_clearance
 FROM sessions actual WHERE actual.workspace_id=w AND actual.id=i
  AND coalesce(session_personal_audience(actual) OR session_workspace_audience(actual),false)
  AND session_project_audience(actual,false) IS TRUE;
 IF NOT FOUND THEN RETURN NULL;END IF;$after$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_parent_audience_dependency_changed: %',signature;END IF;
 END LOOP;
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
 original:=routine.prosrc;
 old_fingerprint:=encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex');
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '80687263de66832b82975ab94d6198a6984898faabfe0badb3990908e87d6834'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR NOT routine.prosecdef OR routine.provolatile<>'s' OR routine.proparallel<>'u' OR routine.prokind<>'f'
  OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR routine.prorettype<>'jsonb'::regtype OR routine.proargtypes<>'2950 2950'::oidvector
  OR routine.proargnames IS DISTINCT FROM ARRAY['w','i'] OR routine.pronargs<>2
  OR routine.proargmodes IS NOT NULL OR routine.proallargtypes IS NOT NULL OR routine.proargdefaults IS NOT NULL
  OR routine.pronargdefaults<>0 OR routine.provariadic<>0 OR routine.proretset OR routine.proisstrict OR routine.proleakproof
  OR routine.procost<>100 OR routine.prorows<>0 OR routine.probin IS NOT NULL OR routine.prosqlbody IS NOT NULL
  OR routine.prosupport<>0 OR routine.protrftypes IS NOT NULL
  OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=routine.proowner AND a.grantor=routine.proowner
    AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
   FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature='native_turn_parent_scope(uuid,uuid)'
   AND h.fingerprint=old_fingerprint)
 THEN RAISE EXCEPTION 'native_parent_audience_predecessor_changed';END IF;
 -- This leaf has one canonical registry pin and no executable literal pins.
 -- A new consumer requires independent review, never an automatic rebaseline.
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
   position(quote_literal(original) IN p.prosrc)>0 OR position(old_fingerprint IN p.prosrc)>0
   OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'native_parent_audience_unexpected_pin_consumer';END IF;
 IF (length(original)-length(replace(original,before_text,'')))/length(before_text)<>1
 THEN RAISE EXCEPTION 'native_parent_audience_splice_changed';END IF;
 successor:=replace(original,before_text,after_text);
 EXECUTE replace(pg_get_functiondef(target),original,successor);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
  OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
 THEN RAISE EXCEPTION 'native_parent_audience_metadata_changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT new_fingerprint FROM pg_proc p WHERE oid=target;
 UPDATE native_turn_contract_helpers h SET fingerprint=new_fingerprint
  WHERE h.signature='native_turn_parent_scope(uuid,uuid)' AND h.fingerprint=old_fingerprint;
 IF NOT FOUND THEN RAISE EXCEPTION 'native_parent_audience_registry_changed';END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_parent_audience_successor_changed: %',signature;END IF;
 END LOOP;
END $native_parent_audience$;
COMMIT;
