-- [COMP:api/native-chat-read-cost] Bound the native automatic Memory operation.
CREATE FUNCTION public.capture_native_prompt_memory_sections(
 w uuid, actor uuid, answering uuid, sid uuid, device uuid, native_version integer,
 credential_actor uuid, include_departments boolean, include_policy boolean, token uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $prompt$
DECLARE
 facts jsonb;
 memory_ids uuid[];
 memory_versions text[];
 dependency record;
 workspace_fields constant text[]:=ARRAY[
  'id','summary','tags','app_id','scope','confidence','valid_to','scope_held','updated_at',
  'workspace_id','user_id','assistant_id','created_by_user_id','scope_version','sensitivity','compartments','project_ids','learning'
 ];
 ranked_fields constant text[]:=workspace_fields||ARRAY['created_at','last_recalled_at','recall_count'];
 member record;
 section jsonb;
 section_roots jsonb;
 observations jsonb:='{}';
 roots jsonb:='[]';
 submitted text[]:='{}';
 proof jsonb;
 refused_message text;
 index integer;
 verdict jsonb;
BEGIN
 IF current_setting('transaction_isolation') NOT IN('repeatable read','serializable') THEN
  RAISE EXCEPTION 'prompt_memory_snapshot_required' USING ERRCODE='42501';
 END IF;
 facts:=public.conversation_record_turn_facts(w,actor,answering,sid,device,native_version,credential_actor,
  include_departments,include_policy,token,'dispatch');
 IF current_setting('app.agent_shared_audience',true)='true'
  OR NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=sid AND s.workspace_id=w
    AND s.user_id=actor AND s.assistant_id=answering AND s.channel_type='web'
    AND s.app_origin='chat' AND s.anchor_kind='none' AND s.anchor_ref IS NULL
    AND s.visibility IN('owner','personal') AND s.mode IS DISTINCT FROM 'draft') THEN
  RETURN facts||jsonb_build_object('kind','unsupported','reason','conversation_shape');
 END IF;

 -- Keep the metadata owner's admission and the complete workspace domain,
 -- including currently denied rows. Scan only the first 101 tuples through
 -- the workspace prefix of idx_memories_visibility. An overfull domain uses
 -- the original owners before evaluating any ancestry or payload.
 IF public.application_memory_query_context(w) IS NULL THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';
 END IF;
 WITH candidate AS MATERIALIZED (
  SELECT m.id,m.scope_version FROM public.memories m WHERE m.workspace_id=w
  ORDER BY m.user_id,m.assistant_id LIMIT 101
 )
 SELECT array_agg(id ORDER BY id),array_agg(scope_version::text ORDER BY id)
 INTO memory_ids,memory_versions FROM candidate;
 IF coalesce(cardinality(memory_ids),0)>100 THEN
  RETURN facts||jsonb_build_object('kind','unsupported','reason','metadata_cohort_bound');
 END IF;
 IF cardinality(memory_ids)>0 THEN
  FOR dependency IN SELECT node_version,source FROM public.read_external_source_dependencies(
   w,array_fill('memory'::text,ARRAY[cardinality(memory_ids)]),memory_ids,memory_versions
  ) LOOP
   IF dependency.source IS NULL OR dependency.node_version IS NULL
    OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
    OR dependency.source->>'workspaceId' IS DISTINCT FROM w::text
    OR dependency.source->>'resourceKind' IS DISTINCT FROM 'external_source'
    OR NOT coalesce(pg_input_is_valid(dependency.source->>'resourceId','uuid'),false)
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   verdict:=jsonb_build_object('kind','unsupported','reason','external_ancestry');
  END LOOP;
  IF verdict IS NOT NULL THEN RETURN facts||verdict;END IF;
 END IF;

 FOR member IN SELECT * FROM (VALUES ('ranked',ranked_fields),('workspace',workspace_fields)) AS m(name,keys) LOOP
  BEGIN
   SELECT jsonb_agg(value ORDER BY ord) INTO section
   FROM public.read_native_memory_query_projection(w,member.keys,true) WITH ORDINALITY p(value,ord);
  EXCEPTION WHEN insufficient_privilege THEN
   GET STACKED DIAGNOSTICS refused_message=MESSAGE_TEXT;
   IF refused_message NOT IN('query_domain_unavailable','access_unavailable') THEN RAISE;END IF;
   observations:=observations||jsonb_build_object(member.name,jsonb_build_object('state','denied'));
   CONTINUE;
  END;
  IF jsonb_typeof(section) IS DISTINCT FROM 'array' OR section->0->'row' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(DISTINCT jsonb_build_object('kind',source->'resourceKind','id',source->'resourceId','version',source->'version'))
  INTO section_roots FROM jsonb_array_elements(section) entry
  CROSS JOIN LATERAL jsonb_array_elements(entry->'sources') source;
  IF section_roots IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  roots:=roots||jsonb_build_array(section_roots);
  submitted:=array_append(submitted,member.name);
  observations:=observations||jsonb_build_object(member.name,jsonb_build_object('state','pending','projection',section));
 END LOOP;

 IF cardinality(submitted)>0 THEN
  proof:=public.capture_conversation_preparation(w,roots,NULL,NULL)->'cohorts';
  IF jsonb_typeof(proof) IS DISTINCT FROM 'array' OR jsonb_array_length(proof)<>cardinality(submitted)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  FOR index IN 1..cardinality(submitted) LOOP
   verdict:=proof->(index-1);
   IF verdict='null'::jsonb THEN
    RETURN facts||jsonb_build_object('kind','unsupported','reason','independent_ancestry');
   ELSIF verdict->>'admitted'='false' THEN
    observations:=jsonb_set(observations,ARRAY[submitted[index]],jsonb_build_object('state','denied'));
   ELSIF verdict->>'admitted'='true' THEN
    observations:=jsonb_set(observations,ARRAY[submitted[index]],
     (observations->submitted[index])||jsonb_build_object('state','admitted','proof',verdict));
   ELSE
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
   END IF;
  END LOOP;
 END IF;
 RETURN facts||jsonb_build_object('kind','sections','indexes',observations);
END $prompt$;
REVOKE ALL ON FUNCTION public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)
 FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)
 TO app_user;
