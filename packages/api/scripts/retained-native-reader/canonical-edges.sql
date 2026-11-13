-- [COMP:api/native-chat-read-cost] Canonical selector scalars are extracted once per retained domain.
CREATE OR REPLACE FUNCTION public.native_turn_edges(w uuid, frontier jsonb)
 RETURNS TABLE(parent jsonb, child jsonb, edge_kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 WITH RECURSIVE f AS MATERIALIZED(SELECT value n FROM jsonb_array_elements(frontier)),
 domain_selectors AS MATERIALIZED(
  SELECT n parent,q.type_key,(q.domain->>'sessionId')::uuid session_id,
   (q.domain->>'throughSequence')::integer through_sequence,q.domain->'fields' selected_fields
  FROM f JOIN application_query_domains q ON n->>'tag'='source' AND n->>'kind'='application_query_domain'
   AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  WHERE q.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND q.type_key IN('session_message','session_message_annotation') AND q.domain->>'kind'='session_query_domain_v1'
 ),
 -- Canonical file ancestry emits ALL predecessors, with the root's requested
 -- version on each edge. Immediate-only edges would alter the edge witness.
 predecessors(root,id) AS (
  SELECT n,wf.id FROM f JOIN workspace_files wf ON n->>'tag'='source'
   AND n->>'kind'='workspace_file' AND wf.workspace_id=w AND wf.id=(n->>'id')::uuid
  UNION
  SELECT p.root,wf.id FROM predecessors p JOIN workspace_files wf
   ON wf.workspace_id=w AND wf.superseded_by=p.id
 ), e AS (
  SELECT n parent,jsonb_build_object('tag','source','kind',s.source_kind,'id',s.source_id,'version',s.source_version) child,'derivation'::text edge_kind
  FROM f JOIN scope_derivations d ON n->>'tag'='source' AND d.workspace_id=w
   AND d.resource_kind=n->>'kind' AND d.resource_id=(n->>'id')::uuid
  JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind',o.source_kind,'id',o.source_id,'version',o.source_version),'observation'
  FROM f JOIN application_field_observations o ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind',s.source_kind,'id',s.source_id,'version',s.source_version),'observation_child'
  FROM f JOIN application_field_observation_sources s ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND s.workspace_id=w AND s.resource_id=(n->>'id')::uuid AND s.version=n->>'version'
  UNION ALL
  SELECT root,jsonb_build_object('tag','source','kind','workspace_file','id',id,'version',root->>'version'),'predecessor'
  FROM predecessors WHERE id<>(root->>'id')::uuid
  UNION ALL
  -- A point dependency is added even when it was filtered from an older scan.
  SELECT n,jsonb_build_object('tag','point','kind',r.type_key,'id',r.resource_id,'fields',to_jsonb(r.fields)),'field_point'
  FROM f JOIN application_field_resources r ON n->>'tag'='source' AND n->>'kind'='application_field'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid
  WHERE r.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND r.type_key IN('session_message','session_message_annotation') AND r.selected_version IS NULL
   AND r.selection IN('read','query','identity')
  UNION ALL
  -- Every physical row, not only admitted/recorded domain candidates.
  SELECT d.parent,jsonb_build_object('tag','point','kind',d.type_key,'id',m.id,'fields',d.selected_fields),'domain_candidate'
  FROM domain_selectors d JOIN session_messages m ON m.workspace_id=w AND m.session_id=d.session_id
   AND m.sequence_num<=d.through_sequence
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text),'point_body'
  FROM f JOIN session_messages m ON n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  UNION ALL
  SELECT n,jsonb_build_object('tag','source','kind','session_context_revision','id',r.id,'version',r.scope_version::text),'point_head'
  FROM f JOIN session_messages m ON n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
  JOIN session_message_annotation_heads h ON h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=m.id
  JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
   AND r.session_id=m.session_id AND r.parent_kind='message_annotation' AND r.parent_id=m.id
  UNION ALL
  -- Conservative dependency: parent-message full closure, never parent ID alone.
  SELECT n,jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text),'revision_parent'
  FROM f JOIN session_context_scope_revisions r ON n->>'tag'='source' AND n->>'kind'='session_context_revision'
   AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.parent_kind='message_annotation'
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=r.session_id AND m.id=r.parent_id
 ) SELECT DISTINCT parent,child,edge_kind FROM e
$function$
