BEGIN;
-- [COMP:api/application-persistence] File-index provenance must retain its
-- original checks without forcing every native field through repeated scans.
DO $install$
DECLARE original text; definition text; body text;
 expected CONSTANT text:='2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376';
 guard text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO original,definition FROM pg_proc
 WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'File session evidence canonical prerequisite changed';END IF;
 body:=replace(original,
  '''session_context_revision'',''session_message'',''memory'')',
  '''session_context_revision'',''session_message'',''memory'',''workspace_file'')');
 body:=replace(body,'''session_message'',''session_context_revision'',''memory'')',
  '''session_message'',''session_context_revision'',''memory'',''workspace_file'')');
 guard:=format($guard$
 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM %L THEN RETURN NULL;END IF;
 $guard$,expected);
 body:=replace(body,E'BEGIN\n IF kinds',E'BEGIN\n'||guard||E'\n IF kinds');
 body:=replace(body,' -- Source-denied physical candidates', $eligibility$
 -- Discover eligibility only. A file with its own derivation, any historical
 -- selector, or independent Page ancestry keeps the complete original path.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN scope_derivations d
   ON d.workspace_id=w AND d.resource_kind='workspace_file' AND d.resource_id=(n->>'id')::uuid
   WHERE n->>'kind'='workspace_file')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
   AND (f.selected_version IS NOT NULL OR f.selection='history')) THEN RETURN NULL;END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='workspace_file' LOOP
  IF read_admitted_page_dependencies(w,'workspace_file',(node->>'id')::uuid,node->>'version')
   IS DISTINCT FROM '[]'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
 -- Source-denied physical candidates$eligibility$);
 body:=replace(body,$return$RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);$return$,
  guard||$return$RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);$return$);
 IF body=original OR position(guard IN body)=0 THEN RAISE EXCEPTION 'File session evidence rewrite unavailable';END IF;
 definition:=replace(definition,original,body);
 definition:=replace(definition,'CREATE OR REPLACE FUNCTION public.read_native_session_cohort_evidence(', 'CREATE OR REPLACE FUNCTION public.read_native_file_session_evidence(');
 EXECUTE definition;
END $install$;
REVOKE ALL ON FUNCTION read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean) TO app_user;
COMMIT;
