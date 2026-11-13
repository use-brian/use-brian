-- [COMP:api/native-chat-read-cost] Typed projection of the pinned canonical edge formulas.
-- Parent indices retain the original tuple. Children become JSON only once per
-- distinct tuple, rather than once for every historical candidate relationship.
CREATE FUNCTION native_retained_edge_rows(w uuid,nodes jsonb[],frontier integer[],privacy boolean)
RETURNS TABLE(parent_index integer,child_tag text,child_kind text,child_id uuid,child_version text,child_fields jsonb,edge_kind integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE f AS MATERIALIZED(SELECT i parent_index,nodes[i+1] n FROM unnest(frontier) i),
 domain_selectors AS MATERIALIZED(
  SELECT f.parent_index,q.type_key,(q.domain->>'sessionId')::uuid session_id,
   (q.domain->>'throughSequence')::integer through_sequence,q.domain->'fields' selected_fields
  FROM f JOIN application_query_domains q ON n->>'tag'='source' AND n->>'kind'='application_query_domain'
   AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  WHERE NOT privacy AND q.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND q.type_key IN('session_message','session_message_annotation') AND q.domain->>'kind'='session_query_domain_v1'
 ), predecessors(root_index,id) AS (
  SELECT parent_index,wf.id FROM f JOIN workspace_files wf ON n->>'tag'='source' AND n->>'kind'='workspace_file'
   AND wf.workspace_id=w AND wf.id=(n->>'id')::uuid WHERE NOT privacy
  UNION SELECT p.root_index,wf.id FROM predecessors p JOIN workspace_files wf ON wf.workspace_id=w AND wf.superseded_by=p.id
 ), e AS (
  SELECT f.parent_index,'source'::text child_tag,s.source_kind child_kind,s.source_id child_id,s.source_version child_version,NULL::jsonb child_fields,1 edge_kind
  FROM f JOIN scope_derivations d ON n->>'tag'='source' AND d.workspace_id=w
   AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source',o.source_kind,o.source_id,o.source_version,NULL,2
  FROM f JOIN application_field_observations o ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version' WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source',s.source_kind,s.source_id,s.source_version,NULL,3
  FROM f JOIN application_field_observation_sources s ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid AND s.version=n->>'version' WHERE NOT privacy
  UNION ALL
  SELECT p.root_index,'source','workspace_file',p.id,f.n->>'version',NULL,4
  FROM predecessors p JOIN f ON f.parent_index=p.root_index WHERE p.id<>(f.n->>'id')::uuid
  UNION ALL
  SELECT f.parent_index,'point',r.type_key,r.resource_id,NULL,to_jsonb(r.fields),5
  FROM f JOIN application_field_resources r ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE NOT privacy AND r.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND r.type_key IN('session_message','session_message_annotation') AND r.selected_version IS NULL
   AND r.selection IN('read','query','identity')
  UNION ALL
  SELECT d.parent_index,'point',d.type_key,m.id,NULL,d.selected_fields,6
  FROM domain_selectors d JOIN session_messages m ON m.workspace_id=w AND m.session_id=d.session_id
   AND m.sequence_num<=d.through_sequence
  UNION ALL
  SELECT f.parent_index,'source','session_message',m.id,m.scope_version::text,NULL,7
  FROM f JOIN session_messages m ON n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source','session_context_revision',r.id,r.scope_version::text,NULL,8
  FROM f JOIN session_messages m ON n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=m.id
  JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
   AND r.session_id=m.session_id AND r.parent_kind='message_annotation' AND r.parent_id=m.id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'source','session_message',m.id,m.scope_version::text,NULL,9
  FROM f JOIN session_context_scope_revisions r ON n->>'tag'='source' AND n->>'kind'='session_context_revision'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.parent_kind='message_annotation'
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=r.session_id AND m.id=r.parent_id WHERE NOT privacy
  UNION ALL
  SELECT f.parent_index,'privacy',s.source_kind,s.source_id,NULL,NULL,0
  FROM f JOIN scope_derivations d ON d.workspace_id=w AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy',o.source_kind,o.source_id,NULL,NULL,0
  FROM f JOIN application_field_observations o ON n->>'kind'='application_field' AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy',s.source_kind,s.source_id,NULL,NULL,0
  FROM f JOIN application_field_observation_sources s ON n->>'kind'='application_field' AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid WHERE privacy
  UNION ALL
  SELECT f.parent_index,'privacy','session_message',r.resource_id,NULL,NULL,0
  FROM f JOIN application_field_resources r ON n->>'kind'='application_field' AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE privacy AND r.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND r.type_key IN('session_message','session_message_annotation')
 ) SELECT DISTINCT parent_index,child_tag,child_kind,child_id,child_version,child_fields,edge_kind FROM e
$$;

CREATE FUNCTION native_retained_intern_frontier(w uuid,nodes jsonb[],frontier integer[],privacy boolean,edge_budget integer)
RETURNS TABLE(added_nodes jsonb[],packed_indices integer[],next_indices integer[],unavailable boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF cardinality(nodes)>4096 OR edge_budget NOT BETWEEN 0 AND 262144 OR array_position(frontier,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(frontier) i WHERE i NOT BETWEEN 0 AND cardinality(nodes)-1) THEN
  RETURN QUERY SELECT '{}'::jsonb[],'{}'::integer[],'{}'::integer[],true;RETURN;
 END IF;
 WITH e AS MATERIALIZED(SELECT * FROM native_retained_edge_rows(w,nodes,frontier,privacy)),
 descriptors AS MATERIALIZED(SELECT DISTINCT child_tag,child_kind,child_id,child_version,child_fields FROM e),
 children AS MATERIALIZED(SELECT d.*,CASE WHEN privacy THEN jsonb_build_object('kind',child_kind,'id',child_id)
  WHEN child_tag='source' THEN jsonb_build_object('tag','source','kind',child_kind,'id',child_id,'version',child_version)
  WHEN child_tag='point' THEN jsonb_build_object('tag','point','kind',child_kind,'id',child_id,'fields',child_fields) END node FROM descriptors d),
 known AS MATERIALIZED(SELECT value node,ordinality::integer-1 node_index FROM unnest(nodes) WITH ORDINALITY q(value,ordinality)),
 fresh AS MATERIALIZED(SELECT DISTINCT c.node FROM children c LEFT JOIN known k ON k.node=c.node WHERE k.node_index IS NULL ORDER BY c.node LIMIT 4097),
 numbered AS MATERIALIZED(SELECT node,cardinality(nodes)+(row_number() OVER(ORDER BY node))::integer-1 node_index FROM fresh),
 child_indices AS MATERIALIZED(SELECT c.*,coalesce(k.node_index,n.node_index) node_index FROM children c
  LEFT JOIN known k ON k.node=c.node LEFT JOIN numbered n ON n.node=c.node),
 resolved AS MATERIALIZED(SELECT e.parent_index,c.node_index,e.edge_kind FROM e LEFT JOIN child_indices c
  ON c.child_tag=e.child_tag AND c.child_kind=e.child_kind AND c.child_id=e.child_id
   AND coalesce(c.child_version,'')=coalesce(e.child_version,'')
   AND coalesce(c.child_fields,'null'::jsonb)=coalesce(e.child_fields,'null'::jsonb)),
 bounded AS MATERIALIZED(SELECT DISTINCT parent_index,node_index,edge_kind FROM resolved ORDER BY parent_index,node_index,edge_kind LIMIT edge_budget+1),
 ordered AS MATERIALIZED(SELECT *,row_number() OVER(ORDER BY parent_index,node_index,edge_kind) ord FROM bounded)
 SELECT (SELECT coalesce(array_agg(node ORDER BY node_index),'{}') FROM numbered),
  (SELECT coalesce(array_agg(v.value ORDER BY o.ord,v.slot),'{}') FROM ordered o
   CROSS JOIN LATERAL(VALUES(1,o.parent_index),(2,o.node_index),(3,o.edge_kind)) v(slot,value)),
  (SELECT coalesce(array_agg(node_index ORDER BY node_index),'{}') FROM numbered),
  cardinality(nodes)+(SELECT count(*) FROM fresh)>4096 OR (SELECT count(*) FROM bounded)>edge_budget
   OR EXISTS(SELECT 1 FROM fresh WHERE native_retained_node_key(node,privacy) IS NULL)
   OR EXISTS(SELECT 1 FROM resolved WHERE node_index IS NULL OR edge_kind IS NULL
    OR CASE WHEN privacy THEN edge_kind<>0 ELSE edge_kind NOT BETWEEN 1 AND 9 END)
 INTO added_nodes,packed_indices,next_indices,unavailable;
 RETURN NEXT;
END $$;

CREATE FUNCTION native_retained_graph_closure(w uuid,seeds jsonb,privacy boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE seeded jsonb;node_values jsonb[];frontier_indices integer[];frontier jsonb;batch record;
 indices integer[]:='{}';step integer:=0;node_bytes bigint;result jsonb;
BEGIN
 seeded:=native_retained_graph_seed(seeds,privacy);IF seeded IS NULL THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(value ORDER BY ordinality),'{}'),coalesce(array_agg(ordinality::integer-1 ORDER BY ordinality),'{}'),
  coalesce(sum(pg_column_size(value)),0) INTO node_values,frontier_indices,node_bytes
 FROM jsonb_array_elements(seeded->'nodes') WITH ORDINALITY;
 WHILE cardinality(frontier_indices)>0 LOOP
  step:=step+1;IF step>4096 THEN RETURN NULL;END IF;
  IF NOT privacy THEN
   SELECT to_jsonb(array_agg(node_values[i+1])) INTO frontier FROM unnest(frontier_indices) i;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(frontier) n WHERE n->>'tag'='source'
    AND n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')) THEN RETURN NULL;END IF;
   IF EXISTS(WITH selectors AS MATERIALIZED(
    SELECT (q.domain->>'sessionId')::uuid session_id,(q.domain->>'throughSequence')::integer through_sequence
    FROM jsonb_array_elements(frontier) n JOIN application_query_domains q
     ON n->>'tag'='source' AND n->>'kind'='application_query_domain' AND q.workspace_id=w AND q.id=(n->>'id')::uuid
    WHERE q.type_key IN('session_message','session_message_annotation'))
    SELECT 1 FROM selectors d WHERE
     (SELECT count(*) FROM(SELECT 1 FROM session_messages m WHERE m.workspace_id=w
      AND m.session_id=d.session_id AND m.sequence_num<=d.through_sequence LIMIT 4097) bounded)>4096) THEN RETURN NULL;END IF;
  END IF;
  SELECT * INTO STRICT batch FROM native_retained_intern_frontier(w,node_values,frontier_indices,privacy,262144-cardinality(indices)/3);
  IF batch.unavailable IS NOT FALSE THEN RETURN NULL;END IF;
  node_values:=node_values||batch.added_nodes;indices:=indices||batch.packed_indices;frontier_indices:=batch.next_indices;
  node_bytes:=node_bytes+pg_column_size(batch.added_nodes);
  IF node_bytes>16777216 THEN RETURN NULL;END IF;
 END LOOP;
 SELECT jsonb_build_object('nodes',to_jsonb(node_values),'edges',coalesce(jsonb_agg(
  jsonb_build_array(indices[n*3+1],indices[n*3+2],indices[n*3+3]) ORDER BY n),'[]'))
 INTO result FROM generate_series(0,cardinality(indices)/3-1) n;
 IF pg_column_size(result)>16777216 THEN RETURN NULL;END IF;
 RETURN result;
END $$;
