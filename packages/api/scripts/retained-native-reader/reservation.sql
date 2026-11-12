-- [COMP:api/native-chat-read-cost] Exact staged adjacency, without another full compiler pass.
CREATE FUNCTION native_retained_capture_plan(w uuid, initial jsonb, captures jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE semantic jsonb:=initial#>'{metadata,witness,graph}';privacy jsonb:=initial#>'{metadata,witness,privacyGraph}';
 staged jsonb;prior_nodes integer;frontier jsonb;batch jsonb;attempts integer:=0;
BEGIN
 IF semantic IS NULL OR privacy IS NULL OR jsonb_array_length(captures)>4096 THEN RETURN NULL;END IF;
 WITH c AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(captures)), staged(parent,child,edge_kind) AS (
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}','version',e#>'{state,sourceVersion}'),'observation'
  FROM c
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',s->'resourceKind','id',s->'resourceId','version',s->'version'),'observation_child'
  FROM c CROSS JOIN LATERAL jsonb_array_elements(e->'sources') s
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','point','kind',e->'typeKey','id',e->'id','fields',e->'fields'),'field_point'
  FROM c WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation') AND e->>'selectedVersion' IS NULL
   AND e->>'selection' IN('read','query','identity')
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_query_domain','id',q->'domainId','version',q->'domainIdentity'),
   jsonb_build_object('tag','point','kind',q->'type','id',m.id,'fields',q#>'{domain,fields}'),'domain_candidate'
  FROM jsonb_array_elements(initial->'queryCaptures') q JOIN session_messages m
   ON m.workspace_id=w AND m.session_id=(q#>>'{domain,sessionId}')::uuid
   AND m.sequence_num<=(q#>>'{domain,throughSequence}')::integer
 ) SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO staged FROM staged s;
 semantic:=native_retained_graph_overlay(semantic,staged,false);
 IF semantic IS NULL OR native_retained_graph_topology(semantic) IS NULL THEN RETURN NULL;END IF;
 WITH c AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(captures)), staged(parent,child) AS (
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}') FROM c
  UNION ALL
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',s->'resourceKind','id',s->'resourceId')
  FROM c CROSS JOIN LATERAL jsonb_array_elements(e->'sources') s
  UNION ALL
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind','session_message','id',e->'id') FROM c
  WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation')
 ) SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO staged FROM staged s;
 prior_nodes:=jsonb_array_length(privacy->'nodes');
 privacy:=native_retained_graph_overlay(privacy,staged,true);
 IF privacy IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') INTO frontier
 FROM jsonb_array_elements(privacy->'nodes') WITH ORDINALITY WHERE ordinality>prior_nodes;
 -- Existing nodes were fully expanded during initial discovery. Close each
 -- newly introduced versionless node with the unchanged canonical edge reader.
 WHILE jsonb_array_length(frontier)>0 LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RETURN NULL;END IF;
  prior_nodes:=jsonb_array_length(privacy->'nodes');
  privacy:=native_retained_expand_frontier(w,privacy,frontier,true);
  IF privacy IS NULL THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') INTO frontier
  FROM jsonb_array_elements(privacy->'nodes') WITH ORDINALITY WHERE ordinality>prior_nodes;
 END LOOP;
 RETURN jsonb_build_object('semantic',semantic,'privacy',privacy);
END $$;
