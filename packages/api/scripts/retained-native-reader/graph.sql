-- [COMP:api/native-chat-read-cost] Private, lossless retained graph representation.
-- These helpers never admit a source. Every integer refers to one complete
-- canonical tuple in this invocation; semantic and recording graphs are separate.
CREATE FUNCTION native_retained_node_key(n jsonb, privacy boolean) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN privacy THEN
  CASE WHEN jsonb_typeof(n)='object' AND n-ARRAY['kind','id']='{}'::jsonb
   AND n ?& ARRAY['kind','id'] AND jsonb_typeof(n->'kind')='string'
   AND jsonb_typeof(n->'id')='string' THEN jsonb_build_array(n->'kind',n->'id')::text END
 ELSE CASE WHEN jsonb_typeof(n)='object' AND (
  n->>'tag'='source' AND n-ARRAY['tag','kind','id','version']='{}'::jsonb
   AND n ?& ARRAY['tag','kind','id','version']
   AND jsonb_typeof(n->'kind')='string' AND jsonb_typeof(n->'id')='string' AND jsonb_typeof(n->'version')='string'
  OR n->>'tag'='point' AND n-ARRAY['tag','kind','id','fields']='{}'::jsonb
   AND n ?& ARRAY['tag','kind','id','fields'] AND jsonb_typeof(n->'kind')='string'
   AND jsonb_typeof(n->'id')='string' AND jsonb_typeof(n->'fields')='array'
 ) THEN native_turn_key(n) END END
$$;

CREATE FUNCTION native_retained_graph_seed(nodes jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ordered jsonb;
BEGIN
 IF jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes)>4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE native_retained_node_key(n,privacy) IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n GROUP BY native_retained_node_key(n,privacy)
   HAVING count(DISTINCT n)>1) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(n ORDER BY native_retained_node_key(n,privacy)),'[]') INTO ordered
 FROM(SELECT DISTINCT value n FROM jsonb_array_elements(nodes)) q;
 RETURN jsonb_build_object('nodes',ordered,'edges','[]'::jsonb);
END $$;

CREATE FUNCTION native_retained_graph_append(graph jsonb, batch jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';added jsonb;packed jsonb;result jsonb;bad boolean;
BEGIN
 IF jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_typeof(graph->'edges') IS DISTINCT FROM 'array'
  OR jsonb_typeof(batch) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 -- Keys are interned once per frontier, using full tuple equality as well as
 -- key equality. A colliding or incomplete tuple is never silently merged.
 WITH known AS MATERIALIZED(SELECT value n,native_retained_node_key(value,privacy) k
  FROM jsonb_array_elements(nodes)), candidates AS MATERIALIZED(
  SELECT DISTINCT e->'child' n,native_retained_node_key(e->'child',privacy) k FROM jsonb_array_elements(batch) e
 ), fresh AS MATERIALIZED(SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM known old WHERE old.k=c.k))
 SELECT (SELECT coalesce(jsonb_agg(n ORDER BY k),'[]') FROM fresh),
  EXISTS(SELECT 1 FROM candidates c WHERE c.k IS NULL)
   OR EXISTS(SELECT 1 FROM candidates c JOIN known old USING(k) WHERE old.n IS DISTINCT FROM c.n)
   OR EXISTS(SELECT 1 FROM candidates GROUP BY k HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(batch) e WHERE
    NOT EXISTS(SELECT 1 FROM known old WHERE old.n=e->'parent')
    OR CASE WHEN privacy THEN e-ARRAY['parent','child']<>'{}'::jsonb
     ELSE e-ARRAY['parent','child','edge_kind']<>'{}'::jsonb
      OR e->>'edge_kind' IS NULL OR e->>'edge_kind'<>ALL(ARRAY['derivation','observation','observation_child',
       'predecessor','field_point','domain_candidate','point_body','point_head','revision_parent']) END)
 INTO added,bad;
 IF bad OR jsonb_array_length(nodes)+jsonb_array_length(added)>4096 THEN RETURN NULL;END IF;
 nodes:=nodes||added;
 WITH indexed AS MATERIALIZED(SELECT value n,ordinality::integer-1 i FROM jsonb_array_elements(nodes) WITH ORDINALITY),
 packed AS(SELECT DISTINCT jsonb_build_array(p.i,c.i,CASE WHEN privacy THEN 0 ELSE
  array_position(ARRAY['derivation','observation','observation_child','predecessor','field_point',
   'domain_candidate','point_body','point_head','revision_parent'],e->>'edge_kind') END) edge
  FROM jsonb_array_elements(batch) e JOIN indexed p ON p.n=e->'parent' JOIN indexed c ON c.n=e->'child')
 SELECT coalesce(jsonb_agg(edge ORDER BY edge),'[]') INTO packed FROM packed;
 result:=jsonb_build_object('nodes',nodes,'edges',(graph->'edges')||packed);
 -- A byte bound applies to the encoded representation, not the number of
 -- historical candidate relationships. It is an optimization eligibility gate.
 IF pg_column_size(result)>16777216 THEN RETURN NULL;END IF;
 RETURN result;
END $$;

CREATE FUNCTION native_retained_graph_edges(graph jsonb, privacy boolean)
RETURNS TABLE(parent jsonb,child jsonb,edge_kind text)
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';
BEGIN
 -- Bind the dictionary once. Extracting graph->'nodes' for every relationship
 -- copies a large JSON value repeatedly and defeats the packed representation.
 RETURN QUERY SELECT nodes->(e->>0)::integer,nodes->(e->>1)::integer,
  CASE WHEN privacy THEN NULL ELSE (ARRAY['derivation','observation','observation_child','predecessor',
   'field_point','domain_candidate','point_body','point_head','revision_parent'])[(e->>2)::integer] END
 FROM jsonb_array_elements(graph->'edges') e;
END
$$;

CREATE FUNCTION native_retained_expand_frontier(w uuid,graph jsonb,frontier jsonb,privacy boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE edge_row record;batch jsonb[]:='{}';
BEGIN
 -- Stream the original relational adjacency in bounded JSON batches. Its
 -- DISTINCT/tuplestore uses PostgreSQL's normal work-memory/spill controls;
 -- no unbounded array of expanded endpoint tuples is constructed here.
 IF privacy THEN
  FOR edge_row IN SELECT * FROM native_turn_privacy_edges(w,frontier) LOOP
   batch:=array_append(batch,to_jsonb(edge_row));
   IF cardinality(batch)=256 THEN
    graph:=native_retained_graph_append(graph,to_jsonb(batch),true);batch:='{}';
    IF graph IS NULL THEN RETURN NULL;END IF;
   END IF;
  END LOOP;
 ELSE
  FOR edge_row IN SELECT * FROM native_turn_edges(w,frontier) LOOP
   batch:=array_append(batch,to_jsonb(edge_row));
   IF cardinality(batch)=256 THEN
    graph:=native_retained_graph_append(graph,to_jsonb(batch),false);batch:='{}';
    IF graph IS NULL THEN RETURN NULL;END IF;
   END IF;
  END LOOP;
 END IF;
 IF cardinality(batch)>0 THEN graph:=native_retained_graph_append(graph,to_jsonb(batch),privacy);END IF;
 RETURN graph;
END $$;

CREATE FUNCTION native_retained_graph_topology(graph jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';keys text[];reverse_edges jsonb;degree_map jsonb;degrees integer[];
 queue integer[]:='{}';cursor_index integer:=1;item integer;parent_index integer;n integer;result jsonb;
BEGIN
 n:=jsonb_array_length(nodes);
 IF n=0 THEN RETURN '[]';END IF;
 IF n>4096 OR pg_column_size(graph)>16777216 OR EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'edges') e
  WHERE jsonb_typeof(e) IS DISTINCT FROM 'array' OR jsonb_array_length(e)<>3
   OR (e->>0)::integer NOT BETWEEN 0 AND n-1 OR (e->>1)::integer NOT BETWEEN 0 AND n-1
   OR (e->>2)::integer NOT BETWEEN 1 AND 9) THEN RETURN NULL;END IF;
 SELECT array_agg(native_retained_node_key(value,false) ORDER BY ordinality) INTO keys
 FROM jsonb_array_elements(nodes) WITH ORDINALITY;
 IF array_position(keys,NULL) IS NOT NULL OR cardinality(keys)<>(SELECT count(DISTINCT k) FROM unnest(keys) k) THEN RETURN NULL;END IF;
 WITH e AS MATERIALIZED(SELECT (value->>0)::integer+1 p,(value->>1)::integer+1 c FROM jsonb_array_elements(graph->'edges')),
 r AS(SELECT c,jsonb_agg(p) parents FROM e GROUP BY c),d AS(SELECT p,count(*) degree FROM e GROUP BY p)
 SELECT (SELECT jsonb_object_agg(c,parents) FROM r),(SELECT jsonb_object_agg(p,degree) FROM d)
 INTO reverse_edges,degree_map;
 SELECT array_agg(coalesce((degree_map->>i::text)::integer,0) ORDER BY i) INTO degrees FROM generate_series(1,n) i;
 FOR item IN 1..n LOOP IF degrees[item]=0 THEN queue:=array_append(queue,item);END IF;END LOOP;
 WHILE cursor_index<=cardinality(queue) LOOP
  item:=queue[cursor_index];cursor_index:=cursor_index+1;
  FOR parent_index IN SELECT value::integer FROM jsonb_array_elements_text(coalesce(reverse_edges->item::text,'[]')) LOOP
   degrees[parent_index]:=degrees[parent_index]-1;
   IF degrees[parent_index]=0 THEN queue:=array_append(queue,parent_index);END IF;
  END LOOP;
 END LOOP;
 IF cardinality(queue)<>n THEN RETURN NULL;END IF;
 SELECT jsonb_agg(keys[q.i] ORDER BY q.ord) INTO result FROM unnest(queue) WITH ORDINALITY q(i,ord);
 RETURN result;
END $$;

CREATE FUNCTION native_retained_graph_overlay(graph jsonb, batch jsonb, privacy boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb:=graph->'nodes';parents jsonb;bad boolean;result jsonb;
BEGIN
 -- A staged observation may introduce a new parent. Keep existing indices
 -- stable, then let the ordinary append intern every new child.
 WITH known AS MATERIALIZED(SELECT value n,native_retained_node_key(value,privacy) k FROM jsonb_array_elements(nodes)),
 candidates AS MATERIALIZED(SELECT DISTINCT e->'parent' n,native_retained_node_key(e->'parent',privacy) k FROM jsonb_array_elements(batch) e),
 fresh AS(SELECT c.* FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM known old WHERE old.k=c.k))
 SELECT (SELECT coalesce(jsonb_agg(n ORDER BY k),'[]') FROM fresh),
  EXISTS(SELECT 1 FROM candidates c WHERE c.k IS NULL)
   OR EXISTS(SELECT 1 FROM candidates c JOIN known old USING(k) WHERE old.n IS DISTINCT FROM c.n)
   OR EXISTS(SELECT 1 FROM candidates GROUP BY k HAVING count(*)>1)
 INTO parents,bad;
 IF bad OR jsonb_array_length(nodes)+jsonb_array_length(parents)>4096 THEN RETURN NULL;END IF;
 result:=native_retained_graph_append(jsonb_set(graph,'{nodes}',nodes||parents),batch,privacy);
 IF result IS NULL THEN RETURN NULL;END IF;
 -- Reused canonical captures add no duplicate relationship to the plan.
 RETURN jsonb_set(result,'{edges}',(SELECT coalesce(jsonb_agg(edge ORDER BY edge),'[]')
  FROM(SELECT DISTINCT value edge FROM jsonb_array_elements(result->'edges')) unique_edges));
END $$;

CREATE FUNCTION native_retained_graph_equal(a jsonb,b jsonb,privacy boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 -- Dictionary order is private and may differ across independent snapshots.
 -- Compare the complete tuples and kind-bearing relations, never only hashes.
 SELECT NOT EXISTS(
  (SELECT value FROM jsonb_array_elements(a->'nodes') EXCEPT SELECT value FROM jsonb_array_elements(b->'nodes'))
  UNION ALL
  (SELECT value FROM jsonb_array_elements(b->'nodes') EXCEPT SELECT value FROM jsonb_array_elements(a->'nodes'))
 ) AND NOT EXISTS(
  (SELECT * FROM native_retained_graph_edges(a,privacy) EXCEPT SELECT * FROM native_retained_graph_edges(b,privacy))
  UNION ALL
  (SELECT * FROM native_retained_graph_edges(b,privacy) EXCEPT SELECT * FROM native_retained_graph_edges(a,privacy))
 )
$$;
