-- [COMP:api/native-chat-read-cost] Reuse only a complete private Memory frame
-- inside the original publication statement. No cross-statement permission cache.
BEGIN;
DO $publication_frame$
DECLARE target regprocedure:='public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure;
 original text;definition text;metadata jsonb;changed text;
 native_before constant text:=$old$  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;$old$;
 native_after constant text:=$new$  ELSIF memo#>>'{memoryStatement,workspaceId}'=w::text
   AND node->>'resourceKind' IN('session_message','session_context_revision','memory') THEN
   -- This exact current point was read and admitted by the complete private
   -- frame above, under the same locks, before any publication mutation.
   SELECT candidate.value||jsonb_build_object('held',false) INTO current_source
    FROM jsonb_array_elements(frame_result->'current') candidate(value)
    WHERE candidate.value->>'resourceKind'=node->>'resourceKind'
     AND candidate.value->>'resourceId'=node->>'resourceId' LIMIT 1;
   IF current_source IS NULL THEN
    current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);
   END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;$new$;
 declaration_before constant text:=$old$memo jsonb:='{}';evaluated jsonb;$old$;
 declaration_after constant text:=$new$memo jsonb:='{}';frame_nodes jsonb;frame_result jsonb;evaluated jsonb;$new$;
 roots_before constant text:=$old$  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);$old$;
 roots_after constant text:=$new$  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);
 -- Discover immutable identities only. The complete private frame still
 -- proves every original source under this publication's native locks.
 IF cardinality(root_ids) BETWEEN 1 AND 100 THEN
  WITH RECURSIVE candidates(kind,id,version) AS (
   SELECT * FROM unnest(root_kinds,root_ids,root_versions)
   UNION SELECT edge.kind,edge.id,edge.version FROM candidates candidate_node
    CROSS JOIN LATERAL application_scope_source_edges(w,candidate_node.kind,candidate_node.id,candidate_node.version) edge
  ), bounded AS MATERIALIZED(SELECT * FROM candidates LIMIT 4097)
  SELECT coalesce(jsonb_agg(to_jsonb(candidate_node)),'[]') INTO frame_nodes FROM bounded candidate_node;
  IF jsonb_array_length(frame_nodes)<=4096
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) candidate_node
    JOIN application_field_resources field ON field.workspace_id=w AND field.id=(candidate_node->>'id')::uuid
    WHERE candidate_node->>'kind'='application_field' AND field.origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND field.type_key='memory' AND field.selection='query_domain') THEN
   frame_result:=read_native_session_cohort_frame(w,root_kinds,root_ids,root_versions,true);
   IF frame_result->>'admitted'='true' AND jsonb_typeof(frame_result->'memo')='object'
    AND frame_result#>>'{memo,memoryStatement,workspaceId}'=w::text THEN
    memo:=frame_result->'memo';
   END IF;
  END IF;
 END IF;
 -- Every original field evaluation, retained tuple comparison and mutation
 -- check below still runs. Unsupported frames retain the canonical fallback.$new$;
BEGIN
 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '310f37bf5fc5c989e42c76d6fff068345c95621479cb7716c24f4268b8fdf01b' THEN
  RAISE EXCEPTION 'Native publication frame prerequisite changed';END IF;
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE oid=target;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'eca5aa0cbf5783306eeef2d5450bdcfee13a4d8aa3e71395b1c6684f50669719'
  OR array_length(string_to_array(original,declaration_before),1)<>2
  OR array_length(string_to_array(original,roots_before),1)<>2
  OR array_length(string_to_array(original,native_before),1)<>2 THEN
  RAISE EXCEPTION 'Native publication frame predecessor changed';END IF;
 changed:=replace(replace(replace(original,declaration_before,declaration_after),roots_before,roots_after),native_before,native_after);
 EXECUTE replace(definition,original,changed);
 IF (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM changed
  OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM metadata
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native publication frame changed function authority';END IF;
END $publication_frame$;
DO $publication_dependencies$
DECLARE target regprocedure:='public.validate_application_field_dependencies()'::regprocedure;
 original text;definition text;metadata jsonb;changed text;trigger_metadata jsonb;
 declaration_before constant text:=$old$history boolean:=false;projection jsonb;label jsonb;fields jsonb;$old$;
 declaration_after constant text:=$new$history boolean:=false;projection jsonb;label jsonb;fields jsonb;frame_result jsonb;$new$;
 loop_before constant text:=$old$ FOR dependency IN SELECT d->>'node_version' AS node_version,d->'source' AS source FROM jsonb_array_elements(fields) d LOOP$old$;
 loop_after constant text:=$new$ -- Each trigger invocation obtains its own complete, current source proof.
 -- This is not a witness from the publisher or a proof shared between rows.
 IF NOT history AND output.resource_kind='session_message' AND output.resource_version='1'
  AND EXISTS(SELECT 1 FROM session_messages message WHERE message.workspace_id=output.workspace_id AND message.id=output.resource_id
   AND message.scope_version=1 AND message.scope_held IS FALSE
   AND (message.user_id,message.assistant_id,message.sensitivity,message.compartments,message.project_ids)
    IS NOT DISTINCT FROM (output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids))
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(fields) candidate
   JOIN application_field_resources field ON field.workspace_id=NEW.workspace_id AND field.id=(candidate#>>'{source,resourceId}')::uuid
   WHERE field.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND field.type_key='memory' AND field.selection='query_domain')
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.application_current_field_snapshot(uuid,uuid)'::regprocedure
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid='public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure)) THEN
  frame_result:=read_native_session_cohort_frame(NEW.workspace_id,ARRAY[NEW.source_kind],ARRAY[NEW.source_id],ARRAY[NEW.source_version],true);
  IF frame_result->>'admitted' IS DISTINCT FROM 'true'
   OR frame_result#>>'{memo,memoryStatement,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text THEN frame_result:=NULL;END IF;
 END IF;
 FOR dependency IN SELECT d->>'node_version' AS node_version,d->'source' AS source FROM jsonb_array_elements(fields) d LOOP$new$;
 current_before constant text:=$old$  current:=application_current_field_snapshot(NEW.workspace_id,(source->>'resourceId')::uuid);$old$;
 current_after constant text:=$new$  SELECT candidate.value||jsonb_build_object('held',false) INTO current
   FROM jsonb_array_elements(frame_result->'current') candidate(value)
   WHERE candidate.value->>'resourceKind'='application_field'
    AND candidate.value->>'resourceId'=source->>'resourceId' LIMIT 1;
  IF current IS NULL THEN current:=application_current_field_snapshot(NEW.workspace_id,(source->>'resourceId')::uuid);END IF;$new$;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE oid=target;
 SELECT to_jsonb(t) INTO trigger_metadata FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass
  AND tgname='application_field_derivation_dependencies';
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091'
  OR array_length(string_to_array(original,declaration_before),1)<>2
  OR array_length(string_to_array(original,loop_before),1)<>2
  OR array_length(string_to_array(original,current_before),1)<>2 THEN
  RAISE EXCEPTION 'Native publication dependency predecessor changed';END IF;
 changed:=replace(replace(replace(original,declaration_before,declaration_after),loop_before,loop_after),current_before,current_after);
 EXECUTE replace(definition,original,changed);
 IF (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM changed
  OR (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM metadata
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass
   AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_metadata
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native publication dependency authority changed';END IF;
END $publication_dependencies$;
COMMIT;
