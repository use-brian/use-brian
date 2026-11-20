// [COMP:api/native-turn-frame] Reviewed read-only adjacency and Page proof.
import { readFile } from 'node:fs/promises'
import { graphReplacements } from './conversation-graph-set.mjs'

const source = file => readFile(new URL(file, import.meta.url), 'utf8')
const seedMarker = 'BEGIN\n SELECT coalesce(jsonb_agg(n)'
const stageMarker = ' -- Stage A retains the VOLATILE canonical per-node edge reads'
const witnessMarker = ' IF verify_nodes<=4096 AND verify_edges<=65536 AND pg_column_size'
const boundsMarker = ' IF jsonb_array_length(edges)>65536'
const nativePointKinds = "'session_message','session_message_annotation'"
const nativeSourceKinds = "'session_message','session_context_revision','application_field','application_query_domain','private_transcript','workspace_file','recording','episode','file_segment','transcript_segment'"

const evidenceRouteMarker = ' -- Fused admission owner (8289). The compiled statements of fused_f_capture'
export const evidenceRouteReplacement = [evidenceRouteMarker, ` -- Directly declared native annotation selectors use the canonical graph.
 -- The compiled evaluator can decline their annotation points only after
 -- expanding the entire retained cohort. Validate the normal shape before
 -- inspecting the exact persisted field observation.
 IF cohorts IS NULL AND jsonb_typeof(roots)='array' THEN
  IF jsonb_array_length(roots) BETWEEN 1 AND 4096 AND (
   WITH input AS MATERIALIZED(
    SELECT n,n->>'kind' kind,n->>'version' version,
     CASE WHEN pg_input_is_valid(n->>'id','uuid') THEN (n->>'id')::uuid END id
    FROM jsonb_array_elements(roots) n
   )
   SELECT NOT EXISTS(SELECT 1 FROM input i WHERE jsonb_typeof(i.n) IS DISTINCT FROM 'object'
    OR i.n-ARRAY['kind','id','version']<>'{}' OR NOT i.n ?& ARRAY['kind','id','version']
    OR jsonb_typeof(i.n->'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(i.n->'id') IS DISTINCT FROM 'string' OR i.id IS NULL
    OR jsonb_typeof(i.n->'version') IS DISTINCT FROM 'string' OR length(i.version) NOT BETWEEN 1 AND 256)
   AND EXISTS(
    SELECT 1 FROM input i JOIN application_field_resources f ON i.kind='application_field' AND f.workspace_id=w AND f.id=i.id
     JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=i.version
    WHERE f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key='session_message_annotation'
     AND f.selected_version IS NULL AND f.selection='query')
  ) THEN RETURN capture_conversation_evidence_generic(w,roots,authority,cohorts);END IF;
 END IF;
${evidenceRouteMarker}`]

function between(text, from, to) {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  if (start < 0 || end < 0) throw Error('conversation_frontier_source_changed: ' + from)
  return text.slice(start, end)
}

// Selecting from a catalog relation makes this an SPI statement. A simple
// stable PL/pgSQL expression could instead reuse the outer statement snapshot.
const snapshot = name => `SELECT pg_current_snapshot()::text INTO ${name} FROM pg_catalog.pg_namespace WHERE nspname='pg_catalog';`

function frontierStatement(dispatch) {
  return `${dispatch}
 ), shape AS MATERIALIZED (
  SELECT NOT EXISTS(SELECT 1 FROM node_input n WHERE (n.tag='point' AND n.kind IN(${nativePointKinds})
   OR n.tag='source' AND n.kind IN(${nativeSourceKinds})) IS NOT TRUE) AS eligible
 ), candidates AS MATERIALIZED (
  SELECT endpoint.parent,endpoint.child FROM (
   SELECT n.node parent,CASE WHEN l.tag='source'
    THEN jsonb_build_object('tag',l.tag,'kind',l.kind,'id',l.id,'version',l.version)
    ELSE jsonb_build_object('tag',l.tag,'kind',l.kind,'id',l.id,'fields',l.fields) END AS child
   FROM live l JOIN node_input n ON n.pos=l.parent WHERE (SELECT eligible FROM shape)
   UNION ALL
   SELECT u.node,e FROM (SELECT t.node FROM support t WHERE NOT t.compiled AND (SELECT eligible FROM shape) OFFSET 0) u
   CROSS JOIN LATERAL conversation_dag_edges(w,u.node) e
  ) endpoint LIMIT (65537-verify_edges)
 ), exact AS MATERIALIZED (
  SELECT DISTINCT parent,child FROM candidates
 ), discovered AS MATERIALIZED (
  SELECT DISTINCT child node FROM exact WHERE NOT visited ? child::text
 )
 SELECT CASE WHEN (SELECT eligible FROM shape) IS NOT TRUE OR (SELECT count(*) FROM candidates)>65536-verify_edges THEN NULL ELSE jsonb_build_object(
  'typed',NOT EXISTS(SELECT 1 FROM support WHERE NOT compiled),
  'edges',(SELECT coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child,'edge_kind','derivation')),'[]') FROM exact),
  'frontier',(SELECT coalesce(jsonb_agg(node),'[]') FROM discovered),
  'members',(SELECT coalesce(jsonb_object_agg(node::text,true),'{}') FROM discovered)
 ) END INTO next_level;`
}

function degreeReplacement(text, seedQuery, splice) {
  const prior = between(text, ' ), expected AS MATERIALIZED(', '\n END IF;\n IF verify_current IS NOT TRUE THEN')
  splice(prior, ` ), expected AS MATERIALIZED(
  SELECT p.pos parent,c.pos child,e.ordinality edge_position
  FROM jsonb_array_elements(edges) WITH ORDINALITY e(value,ordinality)
  JOIN node_input p ON p.node=e.value->'parent'
  JOIN node_input c ON c.node=e.value->'child'
 ), drift AS(
  (SELECT parent,child FROM expected EXCEPT SELECT * FROM fresh)
  UNION ALL
  (SELECT * FROM fresh EXCEPT SELECT parent,child FROM expected)
 ), fresh_seeds AS MATERIALIZED(
  SELECT n FROM (${seedQuery}) roots WHERE use_frontier
 ), seed_drift AS(
  (SELECT n FROM fresh_seeds EXCEPT SELECT value FROM jsonb_array_elements(seeds))
  UNION ALL
  (SELECT value FROM jsonb_array_elements(seeds) EXCEPT SELECT n FROM fresh_seeds)
 ), verified AS MATERIALIZED(
  SELECT (SELECT count(*) FROM fresh_candidates)<=65536 AND
   (SELECT count(*) FROM expected)=verify_edges AND NOT EXISTS(SELECT 1 FROM drift)
   AND (NOT use_frontier OR NOT EXISTS(SELECT 1 FROM seed_drift)) AS ok,
   NOT EXISTS(SELECT 1 FROM support WHERE NOT compiled) AS typed
 ), indexed AS MATERIALIZED(
  SELECT DISTINCT parent,child FROM expected WHERE use_frontier AND (SELECT ok FROM verified)
 ), reverse AS(
  SELECT child,jsonb_agg(parent) parents FROM indexed GROUP BY child
 ), degree AS(
  SELECT parent,count(*) n FROM indexed GROUP BY parent
 ), source_children AS(
  SELECT e.parent,jsonb_agg(c.node ORDER BY e.edge_position) items FROM expected e
  JOIN node_input p ON p.pos=e.parent AND p.tag IS DISTINCT FROM 'point'
   AND p.kind IS DISTINCT FROM 'application_field' AND p.kind IS DISTINCT FROM 'application_query_domain'
  JOIN node_input c ON c.pos=e.child AND c.tag='source'
  WHERE use_frontier AND (SELECT ok FROM verified)
  GROUP BY e.parent
 )
 SELECT ok,typed,(SELECT jsonb_object_agg(child,parents) FROM reverse),
  (SELECT jsonb_object_agg(parent,n) FROM degree),
  (SELECT coalesce(jsonb_object_agg(parent,items),'{}') FROM source_children)
 INTO verify_current,verify_typed,reverse_edges,degree_map,children FROM verified;`)
}

function pageProof() {
  return `BEGIN
    -- A complete union within 4096 nodes proves each root's bound.
    SELECT NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,
     array_fill('session_context_revision'::text,ARRAY[cardinality(page_roots)]),page_roots,
     array_fill('1'::text,ARRAY[cardinality(page_roots)])) n
     WHERE n.kind IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination')) INTO page_free;
    ${snapshot('live_stamp')}
    IF page_free IS NOT TRUE OR page_stamp IS DISTINCT FROM live_stamp THEN page_stamp:=NULL;END IF;
   EXCEPTION WHEN invalid_parameter_value OR insufficient_privilege THEN page_free:=NULL;page_stamp:=NULL;
   END;`
}

function revisionWithProof(body) {
  const start = '\nDECLARE revision session_context_scope_revisions;root jsonb;parent jsonb;source jsonb;admitted jsonb;required jsonb:=\'[]\';\nBEGIN\n'
  const pageLoop = ' FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies'
  if (!body.startsWith(start) || !body.endsWith('\nEND ') || body.split(pageLoop).length !== 2)
    throw Error('conversation_frontier_revision_source_changed')
  const [checks, pages] = body.slice(start.length, -5).split(pageLoop)
  const result = (text, exit) => text.replace(/RETURN ([^;]+);/g, (_, expression) =>
    'source:=' + expression + ';' + (exit ? 'EXIT guarded_revision;' : ''))
  const pageLogic = (pageLoop + pages).replace(' FOR source IN ', ' FOR page_dependency IN ')
    .replaceAll('source->', 'page_dependency->').replaceAll('jsonb_build_array(source)', 'jsonb_build_array(page_dependency)')
  return `    IF page_free IS NOT TRUE OR NOT coalesce(node_id=ANY(page_roots),false) THEN
     source:=conversation_revision_snapshot(w,node_id,memo->'archiveDenied');
    ELSE
     <<guarded_revision>>
     DECLARE revision session_context_scope_revisions;root jsonb;parent jsonb;page_dependency jsonb;admitted jsonb;required jsonb:='[]';
      i uuid:=node_id;archive_denied jsonb:=memo->'archiveDenied';current_page_stamp text;
     BEGIN
${result(checks,true)}  ${snapshot('current_page_stamp')}
  IF current_page_stamp IS DISTINCT FROM page_stamp AND NOT page_refreshed THEN
   page_refreshed:=true;
   page_stamp:=current_page_stamp;
   ${pageProof()}
  END IF;
  IF current_page_stamp=page_stamp THEN
   source:=root||jsonb_build_object('requiredSources','[]'::jsonb);EXIT guarded_revision;
  END IF;
${result(pageLogic,true)}
     END guarded_revision;
    END IF;`
}

export async function frontierReplacements() {
  const [originalGraph, revisions] = await Promise.all([source('graph.sql'),source('native-snapshots.sql')])
  let text = originalGraph.split('CREATE OR REPLACE FUNCTION public.conversation_dag_domain(')[0]
  const splices = []
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw Error('conversation_frontier_marker_changed: ' + before.slice(0, 100))
    text = text.replace(before, () => after)
  }
  const splice = (before, after) => {replace(before, after);splices.push([before,after])}
  for (const [before,after] of graphReplacements) replace(before,after)

  const stage = between(text,stageMarker,witnessMarker)
  const dispatch = between(text,' WITH node_input AS MATERIALIZED(',' ), fresh_candidates AS MATERIALIZED(')
  const seedQuery = between(text, '  SELECT value||', '\n ) selected;')
  const revisionBody = revisions.split('CREATE OR REPLACE FUNCTION public.conversation_revision_snapshot(')[1]?.split('$function$')[1]
  const revisionRead = revisionWithProof(revisionBody)
  const verifyDecl = ' verify_nodes bigint;verify_edges bigint;verify_current boolean;'
  splice(verifyDecl, `${verifyDecl}
 use_frontier boolean:=current_setting('transaction_isolation')='read committed';
 topology_stamp text;live_stamp text;frontier_nodes jsonb;visited jsonb;next_level jsonb;
 frontier_typed boolean;verify_typed boolean;
 node_chunks jsonb[];edge_chunks jsonb[];page_roots uuid[];page_stamp text;page_free boolean;page_refreshed boolean:=false;`)
  splice(seedMarker, `BEGIN
 <<observe_topology>> LOOP
 IF use_frontier THEN ${snapshot('topology_stamp')} END IF;
 verify_current:=NULL;
 SELECT coalesce(jsonb_agg(n)`)
  splice(stage, ` IF use_frontier THEN
  IF jsonb_array_length(seeds)>4096 THEN use_frontier:=false;CONTINUE observe_topology;END IF;
  frontier_nodes:=seeds;node_chunks:='{}';edge_chunks:='{}';frontier_typed:=true;
  SELECT coalesce(jsonb_object_agg(value::text,true),'{}') INTO visited FROM jsonb_array_elements(seeds);
  verify_nodes:=jsonb_array_length(seeds);verify_edges:=0;
  WHILE jsonb_array_length(frontier_nodes)>0 LOOP
${frontierStatement(dispatch.replace('jsonb_array_elements(nodes)', 'jsonb_array_elements(frontier_nodes)'))}
   IF next_level IS NULL THEN use_frontier:=false;CONTINUE observe_topology;END IF;
   frontier_typed:=frontier_typed AND (next_level->>'typed')::boolean;
   -- Per-node canonical calls are volatile. Mixed frontiers still require
   -- one snapshot across discovery and the independent verification.
   IF NOT frontier_typed THEN
    ${snapshot('live_stamp')}
    IF live_stamp IS DISTINCT FROM topology_stamp THEN use_frontier:=false;CONTINUE observe_topology;END IF;
   END IF;
   edge_chunks:=array_append(edge_chunks,next_level->'edges');
   verify_edges:=verify_edges+jsonb_array_length(next_level->'edges');
   frontier_nodes:=next_level->'frontier';
   verify_nodes:=verify_nodes+jsonb_array_length(frontier_nodes);
   IF verify_nodes>4096 THEN use_frontier:=false;CONTINUE observe_topology;END IF;
   visited:=visited||(next_level->'members');
   node_chunks:=array_append(node_chunks,frontier_nodes);
  END LOOP;
  SELECT coalesce(jsonb_agg(node ORDER BY chunk_ord,node_ord),'[]') INTO nodes
  FROM unnest(ARRAY[seeds]||node_chunks) WITH ORDINALITY c(chunk,chunk_ord)
  CROSS JOIN LATERAL jsonb_array_elements(chunk) WITH ORDINALITY n(node,node_ord);
  SELECT coalesce(jsonb_agg(edge ORDER BY chunk_ord,edge_ord),'[]') INTO edges
  FROM unnest(edge_chunks) WITH ORDINALITY c(chunk,chunk_ord)
  CROSS JOIN LATERAL jsonb_array_elements(chunk) WITH ORDINALITY e(edge,edge_ord);
 ELSE
${stage} END IF;
`)
  degreeReplacement(text,seedQuery,splice)
  const stockFallback = ' IF verify_current IS NOT TRUE THEN\n  -- An over-budget'
  splice(stockFallback, ` IF use_frontier THEN
  IF verify_current IS NOT TRUE THEN use_frontier:=false;CONTINUE observe_topology;END IF;
  -- The typed verifier reads all seeds and edges in one SQL statement.
  -- Only its volatile mixed observations still need the original stamp.
  IF NOT (frontier_typed AND verify_typed) THEN
   ${snapshot('live_stamp')}
   IF live_stamp IS DISTINCT FROM topology_stamp THEN use_frontier:=false;CONTINUE observe_topology;END IF;
  END IF;
 END IF;
${stockFallback}`)
  splice(boundsMarker, ` EXIT observe_topology;
 END LOOP observe_topology;
${boundsMarker}`)

  for (const source of [between(text,' WITH indexed AS MATERIALIZED(\n  SELECT DISTINCT (positions','\n SELECT coalesce(array_agg'),
    between(text,' SELECT coalesce(jsonb_object_agg(key,items)','\n SELECT coalesce(min(t)')])
    splice(source, ` IF NOT use_frontier THEN\n${source}\n END IF;`)
  splice("coalesce(children->k,'[]')", "coalesce(children->(CASE WHEN use_frontier THEN item::text ELSE k END),'[]')")
  const loop = ' FOREACH item IN ARRAY queue LOOP'
  splice(loop, ` -- Shared Page ancestry is metadata only. The closed native snapshot
 -- paths below can lock and read, but do not write lineage or alter context.
 IF current_setting('transaction_isolation')='read committed' AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(nodes) n
  LEFT JOIN public.application_field_resources f ON n->>'kind'='application_field' AND f.workspace_id=w AND f.id=(n->>'id')::uuid
  WHERE ((n->>'tag'='point' AND n->>'kind' IN(${nativePointKinds}))
   OR (n->>'tag'='source' AND n->>'kind' IN(${nativeSourceKinds}))) IS NOT TRUE
  OR n->>'kind'='application_field' AND (f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND f.type_key IN(${nativePointKinds}) AND f.selected_version IS NULL) IS NOT TRUE) THEN
  SELECT array_agg(DISTINCT (n->>'id')::uuid ORDER BY (n->>'id')::uuid) INTO page_roots
  FROM jsonb_array_elements(nodes) n WHERE n->>'tag'='source' AND n->>'kind'='session_context_revision';
  IF cardinality(page_roots) BETWEEN 1 AND 100 THEN
   ${snapshot('page_stamp')}
   ${pageProof()}
  END IF;
 END IF;
${loop}`)
  splice("    source:=conversation_revision_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL",
    `${revisionRead}\n    valid:=source IS NOT NULL`)
  return { splices,revisionBody }
}
