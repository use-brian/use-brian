BEGIN;
-- [COMP:api/application-persistence] Reuse the complete file cohort at the
-- existing native title branch, without changing canonical admission or ACLs.
DO $install$
DECLARE item record; original text; definition text; body text; guard text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('session_context_revision_allowed(uuid,uuid)', 'session_context_file_revision_allowed',
   'c84c66cc1d09b2f64ba153f773019b366fbff4bec855aa202179b897947bc5be',
   'chat_proof:=read_native_session_cohort_evidence(', 'chat_proof:=read_native_file_session_evidence(',
   'session_context_revision_allowed(w,i)'),
  ('read_session_context_revision(uuid,uuid)', 'read_session_context_file_revision',
   'cf3245e613753ee7ee51676984a74385b01a0c19b42527322e495e11f49616a0',
   'OR session_context_revision_allowed(w,i)', 'OR session_context_file_revision_allowed(w,i)',
   'read_session_context_revision(w,i)'),
  ('read_session_title_revision(uuid,uuid,uuid)', 'read_native_file_session_title_revision',
   'a4e3606c30586996907ff6668a67b23bb1aeee738ce3e436465a07f7efb16492',
   'RETURN read_session_context_revision(w,i);', 'RETURN read_session_context_file_revision(w,i);',
   'read_session_title_revision(w,s,i)')
 ) AS entries(signature, replacement, fingerprint, old_call, new_call, fallback) LOOP
  SELECT prosrc, pg_get_functiondef(oid) INTO original, definition FROM pg_proc
   WHERE oid=('public.'||item.signature)::regprocedure;
  IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM item.fingerprint
   OR position(item.old_call IN original)=0 THEN
   RAISE EXCEPTION 'Native file title prerequisite changed: %',item.signature;
  END IF;
  -- Any future canonical change restores the original path. This is a
  -- definition check, never a cached actor/source permission result.
  guard:=format($guard$
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid=%L::regprocedure) IS DISTINCT FROM %L
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM 'b5e7109655436be0bd985c9ef13f5f2bd556a6b513e4026a85d67c07da8193ac'
 THEN RETURN %s; END IF;
 $guard$,'public.'||item.signature,item.fingerprint,item.fallback);
  body:=replace(original,item.old_call,item.new_call);
  body:=replace(body,E'BEGIN\n',E'BEGIN\n'||guard);
  definition:=replace(definition,original,body);
  definition:=replace(definition,'CREATE OR REPLACE FUNCTION public.'||split_part(item.signature,'(',1)||'(',
   'CREATE FUNCTION public.'||item.replacement||'(');
  EXECUTE definition;
 END LOOP;
END $install$;
REVOKE ALL ON FUNCTION session_context_file_revision_allowed(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_session_context_file_revision(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_native_file_session_title_revision(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_native_file_session_title_revision(uuid,uuid,uuid) TO app_user;
COMMIT;
