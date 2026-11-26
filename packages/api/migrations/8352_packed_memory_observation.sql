-- [COMP:api/native-chat-read-cost] Use one final exact proof for packed Memory observations.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- Keep the generic observers and the existing application-role reader intact.
-- Each private copy is derived from a reviewed executable predecessor.
DO $packed_memory_observer$
DECLARE original pg_proc; changed text; before_text text; after_text text;
BEGIN
 SELECT * INTO STRICT original FROM pg_proc WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure;
 IF encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5'
  OR to_regprocedure('public.observe_native_prompt_memory_field_once(uuid,jsonb,text,uuid,text,text,text,text[])') IS NOT NULL THEN
  RAISE EXCEPTION 'packed_memory_observe_application_field_projection_predecessor_changed';
 END IF;
 changed:=original.prosrc;
 before_text:=$before$ snapshot jsonb;$before$;
 after_text:=$after$$after$;
 IF cardinality(string_to_array(changed,before_text))<>2 THEN
  RAISE EXCEPTION 'packed_memory_observe_native_prompt_memory_field_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 before_text:=$before$ snapshot:=application_current_field_snapshot(w,(envelope->>'resourceId')::uuid);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'version' IS DISTINCT FROM envelope#>>'{source,version}' THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;$before$;
 after_text:=$after$ -- The materializer compares the immutable identity and version after the
 -- insert. The caller checks every exact current source in one final proof.
 IF scope_review_state_held('application_field',(envelope->>'resourceId')::uuid) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;$after$;
 IF cardinality(string_to_array(changed,before_text))<>2 THEN
  RAISE EXCEPTION 'packed_memory_observe_native_prompt_memory_field_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 EXECUTE replace(replace(pg_get_functiondef(original.oid),original.prosrc,changed),
  'CREATE OR REPLACE FUNCTION public.observe_application_field_projection(', 'CREATE FUNCTION public.observe_native_prompt_memory_field_once(');
 REVOKE ALL ON FUNCTION public.observe_native_prompt_memory_field_once(uuid,jsonb,text,uuid,text,text,text,text[]) FROM PUBLIC,app_user;

 SELECT * INTO STRICT original FROM pg_proc WHERE oid='public.read_native_memory_query_projection(uuid,text[],boolean)'::regprocedure;
 IF encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'6a15e594df7cf73e48647a0cffcfd3a6423012c501864c4113f6cdc868abecd2'
  OR to_regprocedure('public.read_native_memory_query_projection_once(uuid,text[],boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'packed_memory_read_native_memory_query_projection_predecessor_changed';
 END IF;
 changed:=original.prosrc;
 before_text:=$before$observe_application_field_projection($before$;
 after_text:=$after$observe_native_prompt_memory_field_once($after$;
 IF cardinality(string_to_array(changed,before_text))<>3 THEN
  RAISE EXCEPTION 'packed_memory_read_native_memory_query_projection_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 EXECUTE replace(replace(pg_get_functiondef(original.oid),original.prosrc,changed),
  'CREATE OR REPLACE FUNCTION public.read_native_memory_query_projection(', 'CREATE FUNCTION public.read_native_memory_query_projection_once(');
 REVOKE ALL ON FUNCTION public.read_native_memory_query_projection_once(uuid,text[],boolean) FROM PUBLIC,app_user;

 SELECT * INTO STRICT original FROM pg_proc WHERE oid='public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)'::regprocedure;
 IF encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'ecf6950e5d6cd57f244815fde0a6c29a5d9a9ef5aa5f7c00268cb145a7d54022'
  OR to_regprocedure('public.capture_native_prompt_memory_sections_once(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'packed_memory_capture_native_prompt_memory_sections_predecessor_changed';
 END IF;
 changed:=original.prosrc;
 before_text:=$before$read_native_memory_query_projection($before$;
 after_text:=$after$read_native_memory_query_projection_once($after$;
 IF cardinality(string_to_array(changed,before_text))<>2 THEN
  RAISE EXCEPTION 'packed_memory_capture_native_prompt_memory_sections_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 before_text:=$before$ FOR member IN SELECT * FROM (VALUES ('ranked',ranked_fields),('workspace',workspace_fields)) AS m(name,keys) LOOP$before$;
 after_text:=$after$ -- Reserve the same actor and policy rows as the canonical candidate scan.
 -- If the optional no-wait acquisition loses, keep the canonical read path.
 BEGIN
  PERFORM id FROM public.workspaces WHERE id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE SQLSTATE 'P8352'; END IF;
  PERFORM singleton FROM public.application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE SQLSTATE 'P8352'; END IF;
  PERFORM workspace_id FROM public.application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE SQLSTATE 'P8352'; END IF;
 EXCEPTION WHEN lock_not_available THEN RAISE SQLSTATE 'P8352';
 END;
 FOR member IN SELECT * FROM (VALUES ('ranked',ranked_fields),('workspace',workspace_fields)) AS m(name,keys) LOOP$after$;
 IF cardinality(string_to_array(changed,before_text))<>2 THEN
  RAISE EXCEPTION 'packed_memory_capture_native_prompt_memory_sections_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 before_text:=$before$   IF verdict='null'::jsonb THEN
    RETURN facts||jsonb_build_object('kind','unsupported','reason','independent_ancestry');
   ELSIF verdict->>'admitted'='false' THEN
    observations:=jsonb_set(observations,ARRAY[submitted[index]],jsonb_build_object('state','denied'));
   ELSIF verdict->>'admitted'='true' THEN$before$;
 after_text:=$after$   IF verdict='null'::jsonb OR verdict->>'admitted'='false' THEN
    -- The original per-observation final validation may have refused before
    -- the cohort read. Roll back this optional stage before replaying it.
    RAISE SQLSTATE 'P8352';
   ELSIF verdict->>'admitted'='true' THEN
    IF EXISTS(
     SELECT 1 FROM jsonb_array_elements(observations->submitted[index]->'projection') projection
     CROSS JOIN LATERAL jsonb_array_elements(projection->'sources') expected
     WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(verdict->'current') proven WHERE proven=expected)
    ) THEN RAISE SQLSTATE 'P8352'; END IF;$after$;
 IF cardinality(string_to_array(changed,before_text))<>2 THEN
  RAISE EXCEPTION 'packed_memory_capture_native_prompt_memory_sections_once_anchor_changed';
 END IF;
 changed:=replace(changed,before_text,after_text);
 EXECUTE replace(replace(pg_get_functiondef(original.oid),original.prosrc,changed),
  'CREATE OR REPLACE FUNCTION public.capture_native_prompt_memory_sections(', 'CREATE FUNCTION public.capture_native_prompt_memory_sections_once(');
 REVOKE ALL ON FUNCTION public.capture_native_prompt_memory_sections_once(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid) FROM PUBLIC,app_user;
END $packed_memory_observer$;

CREATE FUNCTION public.capture_native_prompt_memory_sections_v2(w uuid, actor uuid, answering uuid, sid uuid, device uuid, native_version integer, credential_actor uuid, include_departments boolean, include_policy boolean, token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb; reader_context jsonb; pass integer;
 owner_oid oid:=current_user::regrole;
 owner_grant aclitem:=makeaclitem(owner_oid,owner_oid,'EXECUTE',false);
 app_grant aclitem:=makeaclitem('app_user'::regrole,owner_oid,'EXECUTE',false);
BEGIN
 IF current_setting('transaction_isolation') IN('repeatable read','serializable') THEN
 BEGIN
  FOR pass IN 1..2 LOOP
   IF EXISTS(
    SELECT 1 FROM (VALUES
   ('public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5','app','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.read_native_memory_query_projection(uuid,text[],boolean)','6a15e594df7cf73e48647a0cffcfd3a6423012c501864c4113f6cdc868abecd2','app','pg_catalog, public, pg_temp','plpgsql','v',true,true),
   ('public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)','ecf6950e5d6cd57f244815fde0a6c29a5d9a9ef5aa5f7c00268cb145a7d54022','app','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.observe_native_prompt_memory_field_once(uuid,jsonb,text,uuid,text,text,text,text[])','095334f4b2036f75b7ae31cdedc4024686fd411141bb881ae5075803c6222176','owner','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.read_native_memory_query_projection_once(uuid,text[],boolean)','28c07d757fa2fe414eb4de7980b1db66a7375c52cb785c28356347193f687cf8','owner','pg_catalog, public, pg_temp','plpgsql','v',true,true),
   ('public.capture_native_prompt_memory_sections_once(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)','453ef45833fc66e70ce4133f19b788e5454d9009332ecff9dd0d38a86ca61cf6','owner','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.application_current_field_snapshot(uuid,uuid)','06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403','owner','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.application_materialize_field_envelope(uuid,jsonb,integer)','6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5','owner','pg_catalog, public, pg_temp','plpgsql','v',true,false),
   ('public.native_turn_context()','366cd2fd2363f8c66843d318b5d49e79ec14fed830de5de4b1cad675b8242583','owner','pg_catalog, public, pg_temp','sql','s',false,false),
   ('public.scope_review_state_held(text,uuid)','641bcd51d90f2d04beba35a2a0845008fe4900ef8bc2f4eea56330d058e5aca6','default','public, pg_temp','sql','s',true,false)
    ) known(signature,body_sha,grants,path,language,volatility,definer,returns_set)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(known.signature)
    LEFT JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid IS NULL OR p.proowner<>owner_oid OR p.pronamespace<>'public'::regnamespace
     OR p.prokind<>'f' OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u'
     OR p.provolatile::text<>known.volatility OR p.proretset<>known.returns_set OR p.prosecdef<>known.definer
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path='||known.path] OR l.lanname<>known.language
     OR p.proacl IS DISTINCT FROM CASE known.grants WHEN 'app' THEN ARRAY[owner_grant,app_grant]
       WHEN 'owner' THEN ARRAY[owner_grant] ELSE NULL::aclitem[] END
     OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>known.body_sha
   ) THEN RAISE SQLSTATE 'P8352'; END IF;
   IF pass=1 THEN
    reader_context:=public.native_turn_context();
    result:=public.capture_native_prompt_memory_sections_once(w,actor,answering,sid,device,native_version,credential_actor,include_departments,include_policy,token);
    -- Only the unchanged preflight can return unsupported without replay.
    -- Any packet with observations needs both final admissions.
    IF result->>'kind' IS DISTINCT FROM 'unsupported' AND (result->>'kind' IS DISTINCT FROM 'sections'
     OR result#>>'{indexes,ranked,state}' IS DISTINCT FROM 'admitted'
     OR result#>>'{indexes,workspace,state}' IS DISTINCT FROM 'admitted') THEN RAISE SQLSTATE 'P8352'; END IF;
   END IF;
  END LOOP;
  IF public.native_turn_context() IS DISTINCT FROM reader_context THEN RAISE SQLSTATE 'P8352'; END IF;
  RETURN result;
 EXCEPTION WHEN SQLSTATE 'P8352' THEN
  -- The subtransaction has discarded all optimized observations and locks.
  NULL;
 END;
 END IF;
 -- A fallback may follow a contract mismatch. Authenticate the original entry
 -- independently before calling it, just as the original app dispatch does.
 IF NOT EXISTS(
  SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid='public.sessions'::regclass
  WHERE p.oid=to_regprocedure('public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)')
   AND p.proowner=c.relowner AND p.proowner=owner_oid AND p.pronamespace='public'::regnamespace
   AND p.proacl=ARRAY[owner_grant,app_grant] AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   AND p.prorettype='jsonb'::regtype AND p.prokind='f' AND p.provolatile='v'
   AND p.prosecdef AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u'
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.pronargdefaults=0
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='ecf6950e5d6cd57f244815fde0a6c29a5d9a9ef5aa5f7c00268cb145a7d54022'
 ) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN public.capture_native_prompt_memory_sections(w,actor,answering,sid,device,native_version,credential_actor,include_departments,include_policy,token);
END $function$;
REVOKE ALL ON FUNCTION public.capture_native_prompt_memory_sections_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_native_prompt_memory_sections_v2(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid) TO app_user;

COMMIT;
