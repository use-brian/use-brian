// [COMP:api/native-turn-frame] Bounded two-observation conversation graph.
export const graphSignature = 'conversation_dag(uuid,jsonb,jsonb)'

const before = `
 WITH RECURSIVE closure(n) AS(
  SELECT value FROM jsonb_array_elements(seeds)
  UNION SELECT e FROM closure c CROSS JOIN LATERAL conversation_dag_edges(w,c.n) e
 ) SELECT coalesce(jsonb_agg(n),'[]') INTO nodes FROM(SELECT n FROM closure LIMIT 4097) bounded;
 IF jsonb_array_length(nodes)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('parent',n,'child',e,'edge_kind','derivation')),'[]') INTO edges
 FROM (SELECT n,e FROM jsonb_array_elements(nodes) n CROSS JOIN LATERAL conversation_dag_edges(w,n) e LIMIT 65537) bounded_edges;`
const after = `
 -- Stage A retains the VOLATILE canonical per-node edge reads while
 -- retaining each distinct observed parent/child tuple.
 WITH RECURSIVE closure(parent,child) AS(
  SELECT NULL::jsonb,value FROM jsonb_array_elements(seeds)
  UNION
  SELECT step.parent,step.child FROM closure c
  CROSS JOIN LATERAL (
   SELECT active.node, adjacent.child FROM (SELECT c.child node WHERE c.parent IS NULL OFFSET 0) active
   CROSS JOIN LATERAL conversation_dag_edges(w,active.node) adjacent(child)
   UNION ALL SELECT NULL::jsonb,c.child WHERE c.parent IS NOT NULL
  ) step(parent,child)
 ), bounded AS MATERIALIZED (
  SELECT parent,child FROM closure LIMIT 69633
 ), budget AS MATERIALIZED(
  SELECT count(*) FILTER(WHERE parent IS NULL) AS nodes,count(*) FILTER(WHERE parent IS NOT NULL) AS edges FROM bounded
 )
 SELECT coalesce(jsonb_agg(child) FILTER(WHERE parent IS NULL AND budget.nodes<=4096),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child,'edge_kind','derivation'))
   FILTER(WHERE parent IS NOT NULL AND budget.nodes<=4096 AND budget.edges<=65536),'[]'),
  (SELECT b.nodes FROM budget b),(SELECT b.edges FROM budget b)
 INTO nodes,edges,verify_nodes,verify_edges FROM bounded CROSS JOIN budget;
 IF verify_nodes<=4096 AND verify_edges<=65536 AND pg_column_size(nodes)+pg_column_size(edges)<=16777216 THEN
 -- Stage B is an independent, fresh SQL statement, at the original second
 -- edge observation boundary. Decline unfamiliar shapes visibly and keep
 -- the canonical enumeration for them; never infer authorization from
 -- the typed output or discard a fresh mismatch.
 WITH node_input AS MATERIALIZED(
  SELECT n.ordinality::integer pos,n.value node,n.value->>'tag' tag,n.value->>'kind' kind,
   CASE WHEN pg_input_is_valid(n.value->>'id','uuid') THEN (n.value->>'id')::uuid END id,
   n.value->>'version' version,n.value->'fields' fields
  FROM jsonb_array_elements(nodes) WITH ORDINALITY n
 ), typed AS MATERIALIZED(
  SELECT n.*,r.id field_id,r.type_key field_type,r.fields field_keys,
   r.resource_id point_id,r.selection,r.selected_version,r.origin field_origin,
   o.resource_id exact_observation,
   q.id domain_id,q.type_key domain_kind,q.origin domain_origin,q.identity domain_identity,
   q.domain domain_document,q.domain->>'kind' domain_form,q.domain->'fields' domain_fields,
   CASE WHEN pg_input_is_valid(q.domain->>'sessionId','uuid') THEN (q.domain->>'sessionId')::uuid END session_id,
   CASE WHEN pg_input_is_valid(q.domain->>'throughSequence','integer') THEN (q.domain->>'throughSequence')::integer END through
  FROM node_input n
  LEFT JOIN public.application_field_resources r ON n.tag='source' AND n.kind='application_field'
   AND r.workspace_id=w AND r.id=n.id
  LEFT JOIN public.application_field_observations o ON r.id IS NOT NULL
   AND o.workspace_id=w AND o.resource_id=r.id AND o.version=n.version
  LEFT JOIN public.application_query_domains q ON n.tag='source' AND n.kind='application_query_domain'
   AND q.workspace_id=w AND q.id=n.id
 ), support AS MATERIALIZED(
  SELECT t.*,(t.id IS NOT NULL AND jsonb_typeof(t.node)='object'
   AND jsonb_typeof(t.node->'id')='string' AND t.node->>'id'=t.id::text
   AND CASE WHEN t.tag='point' THEN
    t.node ?& ARRAY['tag','kind','id','fields'] AND t.node-ARRAY['tag','kind','id','fields']='{}'::jsonb
   WHEN t.tag='source' THEN
    t.node ?& ARRAY['tag','kind','id','version'] AND t.node-ARRAY['tag','kind','id','version']='{}'::jsonb
    AND jsonb_typeof(t.node->'version')='string'
   ELSE false END AND CASE
   WHEN t.tag='point' AND t.kind IN('session_message','session_message_annotation') THEN
    jsonb_typeof(t.fields)='array' AND NOT t.node ? 'version'
    AND t.fields=to_jsonb(ARRAY(SELECT f FROM unnest(application_session_field_keys(t.kind)) f ORDER BY f))
   WHEN t.tag='source' AND t.kind IN('session_message','session_context_revision') THEN
    t.version ~ '^[0-9]+$' AND NOT t.node ? 'fields'
   WHEN t.tag='source' AND t.kind='application_field' THEN
    t.field_id IS NOT NULL AND t.exact_observation IS NOT NULL AND t.selected_version IS NULL
    AND t.field_origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND t.field_type IN('session_message','session_message_annotation')
    AND t.selection IN('query','identity','read','query_domain')
    AND to_jsonb(t.field_keys)=to_jsonb(ARRAY(SELECT f FROM unnest(application_session_field_keys(t.field_type)) f ORDER BY f))
   WHEN t.tag='source' AND t.kind='application_query_domain' THEN
    t.domain_id IS NOT NULL AND t.domain_identity=t.version AND t.domain_form='session_query_domain_v1'
    AND t.domain_origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND t.domain_kind IN('session_message','session_message_annotation') AND t.session_id IS NOT NULL AND t.through>=0
    AND t.domain_document ?& ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']
    AND t.domain_document-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']='{}'::jsonb
    AND jsonb_typeof(t.domain_document->'sessionId')='string' AND t.domain_document->>'sessionId'=t.session_id::text
    AND jsonb_typeof(t.domain_document->'throughSequence')='number'
    AND t.domain_fields=to_jsonb(ARRAY(SELECT f FROM unnest(application_session_field_keys(t.domain_kind)) f ORDER BY f))
   ELSE false END) IS TRUE compiled FROM typed t
 ), eligible AS MATERIALIZED(
  SELECT t.* FROM support t WHERE t.compiled
 ), live(parent,tag,kind,id,version,fields) AS (
  SELECT n.pos,'source'::text,s.source_kind,s.source_id,s.source_version,NULL::jsonb
  FROM eligible n JOIN public.scope_derivations d ON d.workspace_id=w AND d.resource_kind=n.kind AND d.resource_id=n.id
   JOIN public.scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE n.tag='source'
  UNION ALL
  SELECT n.pos,'source',o.source_kind,o.source_id,o.source_version,NULL::jsonb
  FROM eligible n JOIN public.application_field_observations o ON o.workspace_id=w AND o.resource_id=n.field_id AND o.version=n.version
  WHERE n.tag='source' AND n.kind='application_field'
  UNION ALL
  SELECT n.pos,'source',o.source_kind,o.source_id,o.source_version,NULL::jsonb
  FROM eligible n JOIN public.application_field_observation_sources o ON o.workspace_id=w AND o.resource_id=n.field_id AND o.version=n.version
  WHERE n.tag='source' AND n.kind='application_field'
  UNION ALL
  SELECT n.pos,'point',n.field_type,n.point_id,NULL::text,to_jsonb(n.field_keys)
  FROM eligible n
  WHERE n.tag='source' AND n.kind='application_field' AND n.selection IN('query','identity','read')
  UNION ALL
  SELECT n.pos,'point',n.domain_kind,m.id,NULL::text,n.domain_fields
  FROM eligible n JOIN public.session_messages m ON m.workspace_id=w AND m.session_id=n.session_id AND m.sequence_num<=n.through
  WHERE n.tag='source' AND n.kind='application_query_domain'
  UNION ALL
  SELECT n.pos,'source','session_message',m.id,m.scope_version::text,NULL::jsonb
  FROM eligible n JOIN public.session_messages m ON m.workspace_id=w AND m.id=n.id
  WHERE n.tag='point'
  UNION ALL
  SELECT n.pos,'source','session_context_revision',r.id,r.scope_version::text,NULL::jsonb
  FROM eligible n JOIN public.session_message_annotation_heads h ON h.workspace_id=w AND h.message_id=n.id
   JOIN public.session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
    AND r.session_id=h.session_id AND r.parent_kind='message_annotation' AND r.parent_id=h.message_id
  WHERE n.tag='point' AND n.kind='session_message_annotation'
 ), fresh_candidates AS MATERIALIZED(
  SELECT endpoint.parent,endpoint.child FROM (
   SELECT l.parent,n.pos child
   FROM live l LEFT JOIN node_input n ON n.tag=l.tag AND n.kind=l.kind AND n.id=l.id
    AND n.version IS NOT DISTINCT FROM l.version AND n.fields IS NOT DISTINCT FROM l.fields
   UNION ALL
   SELECT u.pos,n.pos
   FROM (SELECT t.pos,t.node FROM support t WHERE NOT t.compiled OFFSET 0) u
   CROSS JOIN LATERAL conversation_dag_edges(w,u.node) e
   LEFT JOIN node_input n ON n.node=e
  ) endpoint LIMIT 65537
 ), fresh AS MATERIALIZED(
  SELECT DISTINCT candidate.parent,candidate.child FROM fresh_candidates candidate
 ), expected AS MATERIALIZED(
  SELECT p.pos parent,c.pos child FROM jsonb_array_elements(edges) e
  JOIN node_input p ON p.node=e->'parent'
  JOIN node_input c ON c.node=e->'child'
 ), drift AS(
  (SELECT * FROM expected EXCEPT SELECT * FROM fresh)
  UNION ALL
  (SELECT * FROM fresh EXCEPT SELECT * FROM expected)
 )
 SELECT (SELECT count(*) FROM fresh_candidates)<=65536 AND
  (SELECT count(*) FROM expected)=verify_edges AND NOT EXISTS(SELECT 1 FROM drift)
 INTO verify_current;
 END IF;
 IF verify_current IS NOT TRUE THEN
  -- An over-budget observation or disagreement cannot supply topology.
  -- The canonical compiler rediscovers both current closure and adjacency.
${before}
 END IF;`

const originalMemo = `
 SELECT coalesce(jsonb_object_agg(key,completed[value::integer]),'{}') INTO flat FROM jsonb_each_text(slots);
 SELECT memo||coalesce(jsonb_object_agg(key,value) FILTER(WHERE key LIKE 'field:%' OR key LIKE 'native:%'),'{}')
  ||jsonb_build_object(
   'points',coalesce(jsonb_object_agg(substring(key FROM 8),value) FILTER(WHERE key LIKE 'points:%'),'{}'),
   'envelopes',coalesce(jsonb_object_agg(substring(key FROM 11),value) FILTER(WHERE key LIKE 'envelopes:%'),'{}'),
   'domains',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'domains:%'),'{}'),
   'current',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'current:%'),'{}'))
 INTO memo FROM jsonb_each(flat);`

const directMemo = `
 SELECT memo||coalesce(jsonb_object_agg(slot.key,entry.value) FILTER(WHERE slot.key LIKE 'field:%' OR slot.key LIKE 'native:%'),'{}')
  ||jsonb_build_object(
   'points',coalesce(jsonb_object_agg(substring(slot.key FROM 8),entry.value) FILTER(WHERE slot.key LIKE 'points:%'),'{}'),
   'envelopes',coalesce(jsonb_object_agg(substring(slot.key FROM 11),entry.value) FILTER(WHERE slot.key LIKE 'envelopes:%'),'{}'),
   'domains',coalesce(jsonb_object_agg(substring(slot.key FROM 9),entry.value) FILTER(WHERE slot.key LIKE 'domains:%'),'{}'),
   'current',coalesce(jsonb_object_agg(substring(slot.key FROM 9),entry.value) FILTER(WHERE slot.key LIKE 'current:%'),'{}'))
 INTO memo FROM jsonb_each_text(slots) AS slot(key,position)
 CROSS JOIN LATERAL (SELECT completed[slot.position::integer] AS value OFFSET 0) entry;`

export const graphReplacements = [
  [';flat jsonb;privacy jsonb;', ';privacy jsonb;'],
  ['BEGIN\n SELECT coalesce(jsonb_agg(n)', ' verify_nodes bigint;verify_edges bigint;verify_current boolean;\nBEGIN\n SELECT coalesce(jsonb_agg(n)'],
  [before, after],
  [originalMemo, directMemo],
]
