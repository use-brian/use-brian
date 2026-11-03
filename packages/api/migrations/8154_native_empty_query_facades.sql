BEGIN;
-- [COMP:api/application-persistence] Reuse the existing closed proof at the
-- server evidence and title entry points. No caller memo or permission token.
DO $prerequisites$
DECLARE item record;p pg_proc;
BEGIN
 IF application_empty_query_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Canonical empty-query helpers changed';END IF;
 FOR item IN SELECT * FROM (VALUES
  ('session_context_file_revision_allowed(uuid,uuid)','0c5191609b4ee47e2e43ed447ed50bc6001a832cbf037fdfc0a967241e6d0c8b',ARRAY['w','i']),
  ('read_session_context_file_revision(uuid,uuid)','ec4636eb884f9a4bf5bd0c0ac6fb5eed1aed64c1cd790d823467be5682db1a99',ARRAY['w','i']),
  ('read_native_file_session_title_revision(uuid,uuid,uuid)','896e852d3284bdfc7df82e575299ba6115beffc2476f07e2e00917376042f15e',ARRAY['w','s','i'])
 ) expected(signature,fingerprint,argnames) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(item.signature);
  IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM item.fingerprint
   OR p.proowner<>(SELECT proowner FROM pg_proc WHERE oid='application_empty_query_helpers_current()'::regprocedure)
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR p.prokind<>'f'
   OR p.prosecdef IS NOT TRUE OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.proisstrict OR p.proleakproof OR p.proretset
   OR p.procost<>100 OR p.prorows<>0 OR p.provariadic<>0 OR p.prosupport<>0 OR p.pronargdefaults<>0
   OR p.proargdefaults IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL OR p.protrftypes IS NOT NULL
   OR p.probin IS NOT NULL OR p.prosqlbody IS NOT NULL
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR p.proargnames IS DISTINCT FROM item.argnames
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantor<>p.proowner OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable
     OR acl.grantee<>p.proowner AND NOT(p.proname='read_native_file_session_title_revision'
      AND acl.grantee=coalesce((SELECT oid FROM pg_roles WHERE rolname='app_user'),0) AND acl.grantee<>0))
  THEN RAISE EXCEPTION 'Canonical title prerequisite changed: %',item.signature;END IF;
 END LOOP;
END $prerequisites$;

CREATE FUNCTION read_native_empty_query_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF application_empty_query_facades_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN read_native_empty_query_session_evidence(w,kinds,ids,versions,true);
END $$;

DO $titles$
DECLARE item record;original text;definition text;updated text;guard text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('session_context_file_revision_allowed(uuid,uuid)','session_context_empty_query_revision_allowed',
   'chat_proof:=read_native_file_session_evidence(', 'chat_proof:=read_native_empty_query_session_evidence(',
   'session_context_file_revision_allowed(w,i)'),
  ('read_session_context_file_revision(uuid,uuid)','read_session_context_empty_query_revision',
   'OR session_context_file_revision_allowed(w,i)', 'OR session_context_empty_query_revision_allowed(w,i)',
   'read_session_context_file_revision(w,i)'),
  ('read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_empty_query_session_title_revision',
   'RETURN read_session_context_file_revision(w,i);', 'RETURN read_session_context_empty_query_revision(w,i);',
   'read_native_file_session_title_revision(w,s,i)')
 ) replacements(signature,replacement,old_call,new_call,fallback) LOOP
  SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc WHERE oid=item.signature::regprocedure;
  IF position(item.old_call IN original)=0 THEN RAISE EXCEPTION 'Canonical title call unavailable';END IF;
  updated:=replace(original,item.old_call,item.new_call);
  -- A cohort outside the new family must retain the entire previous reader.
  IF item.replacement='session_context_empty_query_revision_allowed' THEN
   updated:=replace(updated,'chat_proof:=read_native_empty_query_session_evidence(w,ARRAY[''session_context_revision''],ARRAY[i],ARRAY[''1''],true);',
    'chat_proof:=read_native_file_session_evidence(w,ARRAY[''session_context_revision''],ARRAY[i],ARRAY[''1''],true);'
    ||E'\n   IF chat_proof IS NULL THEN chat_proof:=read_native_empty_query_session_evidence(w,ARRAY[''session_context_revision''],ARRAY[i],ARRAY[''1''],true);END IF;'
    ||E'\n   IF chat_proof IS NULL THEN RETURN session_context_file_revision_allowed(w,i);END IF;');
  END IF;
  guard:=format(E' IF application_empty_query_facades_current() IS NOT TRUE THEN RETURN %s;END IF;\n',item.fallback);
  updated:=overlay(updated placing guard from position(E'BEGIN\n' IN updated)+length(E'BEGIN\n') for 0);
  definition:=replace(definition,original,updated);
  definition:=replace(definition,'CREATE OR REPLACE FUNCTION public.'||split_part(item.signature,'(',1)||'(',
   'CREATE FUNCTION public.'||item.replacement||'(');
  EXECUTE definition;
 END LOOP;
END $titles$;

-- Normalize inherited defaults to owner-only before the narrow public grants.
DO $acl$
DECLARE routine record;recipient record;
BEGIN
 FOR routine IN SELECT oid::regprocedure signature,proowner,proacl FROM pg_proc WHERE oid IN(
  'read_native_empty_query_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,
  'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,
  'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine.signature);
  FOR recipient IN SELECT DISTINCT r.rolname FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>routine.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine.signature,recipient.rolname);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_native_empty_query_evidence(uuid,text[],uuid[],text[]) TO app_user;
  GRANT EXECUTE ON FUNCTION read_native_empty_query_session_title_revision(uuid,uuid,uuid) TO app_user;
 END IF;
END $acl$;

DO $guard$
DECLARE pins text;
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
 EXECUTE 'CREATE FUNCTION application_empty_query_facades_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '||quote_literal(
  'BEGIN
   IF (SELECT count(*)=8 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END');
END $guard$;
REVOKE ALL ON FUNCTION application_empty_query_facades_current() FROM PUBLIC;
DO $acl$
DECLARE recipient record;
BEGIN
 FOR recipient IN SELECT DISTINCT r.rolname FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
  WHERE p.oid='application_empty_query_facades_current()'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION application_empty_query_facades_current() FROM %I',recipient.rolname);
 END LOOP;
END $acl$;
COMMIT;
