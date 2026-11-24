BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/native-turn-frame] Intern verified conversation graph edges as pairs of node positions.
DO $conversation_ordinal_edges$
DECLARE
 member_signature constant text:='conversation_dag(uuid,jsonb,jsonb)';
 helper constant regprocedure:='public.conversation_dag(uuid,jsonb,jsonb)'::regprocedure;
 original pg_proc;
 changed text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT original FROM pg_catalog.pg_proc WHERE oid=helper;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
  OR encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'8a887ded19422fea33e084e6b9d1f8b9dfb85811493f50751412a8190777b15b'
  OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=member_signature
    AND (h.contract).oid=helper::oid AND (h.contract).prosrc=original.prosrc)
 THEN RAISE EXCEPTION 'conversation_ordinal_edges_predecessor_changed';END IF;

 changed:=original.prosrc;
 changed:=replace(changed,$before$SELECT coalesce(jsonb_object_agg(value::text,true),'{}') INTO visited FROM jsonb_array_elements(seeds);$before$,$after$SELECT coalesce(jsonb_object_agg(value::text,ordinality),'{}') INTO visited FROM jsonb_array_elements(seeds) WITH ORDINALITY;$after$);
 changed:=replace(changed,$before$  SELECT DISTINCT child node FROM exact WHERE NOT visited ? child::text
 )$before$,$after$  SELECT DISTINCT child node FROM exact WHERE NOT visited ? child::text
 ), numbered AS MATERIALIZED (
  SELECT node,verify_nodes + row_number() OVER () AS pos FROM discovered
 )$after$);
 changed:=replace(changed,$before$  'edges',(SELECT coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child,'edge_kind','derivation')),'[]') FROM exact),
  'frontier',(SELECT coalesce(jsonb_agg(node),'[]') FROM discovered),
  'members',(SELECT coalesce(jsonb_object_agg(node::text,true),'{}') FROM discovered)$before$,$after$  'edges',(SELECT coalesce(jsonb_agg(jsonb_build_array((visited->>e.parent::text)::integer,
    coalesce(n.pos,(visited->>e.child::text)::integer))),'[]')
   FROM exact e LEFT JOIN numbered n ON n.node=e.child),
  'frontier',(SELECT coalesce(jsonb_agg(node ORDER BY pos),'[]') FROM numbered),
  'members',(SELECT coalesce(jsonb_object_agg(node::text,pos),'{}') FROM numbered)$after$);
 changed:=replace(changed,$before$ )
 SELECT coalesce(jsonb_agg(child) FILTER(WHERE parent IS NULL AND budget.nodes<=4096),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child,'edge_kind','derivation'))
   FILTER(WHERE parent IS NOT NULL AND budget.nodes<=4096 AND budget.edges<=65536),'[]'),
  (SELECT b.nodes FROM budget b),(SELECT b.edges FROM budget b)
 INTO nodes,edges,verify_nodes,verify_edges FROM bounded CROSS JOIN budget;$before$,$after$ ), numbered AS MATERIALIZED (
  SELECT child AS node,row_number() OVER () AS pos FROM bounded CROSS JOIN budget
  WHERE parent IS NULL AND budget.nodes<=4096
 )
 SELECT (SELECT coalesce(jsonb_agg(node ORDER BY pos),'[]') FROM numbered),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(p.pos,c.pos)),'[]') FROM bounded e
   LEFT JOIN numbered p ON p.node=e.parent LEFT JOIN numbered c ON c.node=e.child
   WHERE e.parent IS NOT NULL AND budget.nodes<=4096 AND budget.edges<=65536),
  budget.nodes,budget.edges INTO nodes,edges,verify_nodes,verify_edges FROM budget;$after$);
 changed:=replace(changed,$before$  SELECT p.pos parent,c.pos child,e.ordinality edge_position
  FROM jsonb_array_elements(edges) WITH ORDINALITY e(value,ordinality)
  JOIN node_input p ON p.node=e.value->'parent'
  JOIN node_input c ON c.node=e.value->'child'$before$,$after$  SELECT (e.value->>0)::integer parent,(e.value->>1)::integer child,e.ordinality edge_position
  FROM jsonb_array_elements(edges) WITH ORDINALITY e(value,ordinality)$after$);
 changed:=replace(changed,$before$ SELECT coalesce(jsonb_agg(jsonb_build_object('parent',n,'child',e,'edge_kind','derivation')),'[]') INTO edges
 FROM (SELECT n,e FROM jsonb_array_elements(nodes) n CROSS JOIN LATERAL conversation_dag_edges(w,n) e LIMIT 65537) bounded_edges;$before$,$after$ WITH numbered AS MATERIALIZED (
  SELECT value AS node,ordinality AS pos FROM jsonb_array_elements(nodes) WITH ORDINALITY
 ), bounded_edges AS MATERIALIZED (
  SELECT p.pos AS parent_pos,e.child FROM numbered p
  CROSS JOIN LATERAL conversation_dag_edges(w,p.node) e(child) LIMIT 65537
 )
 SELECT coalesce(jsonb_agg(jsonb_build_array(e.parent_pos,c.pos)),'[]') INTO edges
 FROM bounded_edges e LEFT JOIN numbered c ON c.node=e.child;$after$);
 changed:=replace(changed,$before$ IF jsonb_array_length(edges)>65536 OR pg_column_size(nodes)+pg_column_size(edges)>16777216$before$,$after$ -- The byte budget counts each full node once and both positions of every edge.
 -- Preserve missing endpoints from a changing canonical snapshot as a refusal.
 IF jsonb_array_length(edges)>65536 OR pg_column_size(nodes)+pg_column_size(edges)>16777216
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(edges) e WHERE e->>0 IS NULL OR e->>1 IS NULL)$after$);
 changed:=replace(changed,$before$  SELECT DISTINCT (positions->>native_turn_key(e->'parent'))::integer p,
   (positions->>native_turn_key(e->'child'))::integer c FROM jsonb_array_elements(edges) e$before$,$after$  SELECT DISTINCT (e->>0)::integer p,(e->>1)::integer c FROM jsonb_array_elements(edges) e$after$);
 changed:=replace(changed,$before$  SELECT native_turn_key(e->'parent') key,jsonb_agg(e->'child') items FROM jsonb_array_elements(edges) e GROUP BY 1$before$,$after$  SELECT native_turn_key(p.node) key,jsonb_agg(c.node ORDER BY e.ordinality) items
  FROM jsonb_array_elements(edges) WITH ORDINALITY e(edge,ordinality)
  JOIN jsonb_array_elements(nodes) WITH ORDINALITY p(node,pos) ON p.pos=(e.edge->>0)::integer
  JOIN jsonb_array_elements(nodes) WITH ORDINALITY c(node,pos) ON c.pos=(e.edge->>1)::integer
  WHERE p.node->>'tag' IS DISTINCT FROM 'point'
   AND p.node->>'kind' NOT IN ('application_field','application_query_domain') AND c.node->>'tag'='source'
  GROUP BY 1$after$);
 IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>'ab21130ce3289e1d773ea21a8956f93d939eec2ae4fd284212da8f219f0fa6e4'
 THEN RAISE EXCEPTION 'conversation_ordinal_edges_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(helper),original.prosrc,changed);
 IF (SELECT to_jsonb(p) FROM pg_catalog.pg_proc p WHERE p.oid=helper)
  IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
 THEN RAISE EXCEPTION 'conversation_ordinal_edges_metadata_changed';END IF;
 UPDATE public.native_turn_contract_helpers h
 SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
 WHERE h.signature=member_signature;
 IF NOT FOUND OR public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_ordinal_edges_witness_changed';END IF;
END $conversation_ordinal_edges$;

COMMIT;
