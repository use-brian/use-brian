-- [COMP:api/native-chat-read-cost] Exact original-cohort projection with recording expiry.
CREATE OR REPLACE FUNCTION public.native_retained_capture_cohorts(w uuid, roots jsonb, cohorts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE selectors jsonb:='[]';cohort jsonb;cohort_keys text[];cohort_packets jsonb:='[]';
 evidence_entries jsonb[]:='{}';evidence_map jsonb;packet jsonb;meta jsonb;frame jsonb;source_nodes jsonb;point_values jsonb:='[]';immutable jsonb:='[]';currents jsonb:='[]';
 nodes_by_key jsonb;original_keys jsonb;root_kinds text[];root_ids uuid[];root_versions text[];node jsonb;result jsonb;source jsonb;key text;dependency jsonb;derivation jsonb;
 memo jsonb:='{"nativeWorklist":true}';observed_at timestamptz:=clock_timestamp();deadline timestamptz;
 memory_context jsonb;observation application_field_observations;field_dependencies jsonb;point_map jsonb:='{}';field_map jsonb:='{}';scope_map jsonb:='{}';query_envelopes jsonb:='{}';point_key text;
 selector jsonb;query_captures jsonb:='[]';query_parent jsonb;query_bounds jsonb;query_visibility jsonb;query_fields text[];query_scan jsonb;
 query_envelope_slots jsonb:='{}';query_envelope_values jsonb[]:='{}';query_envelope jsonb;
BEGIN
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'native_turn_principal_required' USING ERRCODE='42501';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 meta:=native_retained_metadata(w,roots,selectors,false);
 IF meta->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM(
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT (audience#>>'{binding,expiresAt}')::timestamptz FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 WHERE audience#>>'{binding,expiresAt}' IS NOT NULL) transitions;
 SELECT jsonb_object_agg(native_turn_key(n),n),jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version') FILTER(WHERE n->>'tag'='source')
 INTO nodes_by_key,source_nodes FROM jsonb_array_elements(meta#>'{witness,graph,nodes}') n;
 -- Index only the exact physical field dependency predicate used below.
 WITH indexed AS MATERIALIZED(SELECT native_turn_key(edge.parent) parent_key,edge.child child
  FROM native_retained_graph_edges(meta#>'{witness,graph}',false) edge WHERE edge.child->>'kind'='application_field'),
 grouped AS(SELECT parent_key,jsonb_agg(child) children FROM indexed GROUP BY parent_key)
 SELECT coalesce(jsonb_object_agg(parent_key,children),'{}') INTO field_dependencies FROM grouped;
 frame:=native_turn_capture_sources(w,meta);
 IF frame IS NULL OR frame->>'closed' IS DISTINCT FROM 'true' OR EXISTS(
 SELECT 1 FROM jsonb_each(frame->'currents') e WHERE e.value#>>'{source,held}' IS DISTINCT FROM 'false'
  OR e.value#>>'{source,validTo}' IS NOT NULL OR e.value#>>'{source,retractedAt}' IS NOT NULL)
 THEN RETURN jsonb_build_object('available',false,'reason','source_admission');END IF;
 WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
  SELECT parent,child FROM native_retained_graph_edges(meta#>'{witness,graph}',false)
  WHERE edge_kind IN('derivation','observation','observation_child','predecessor')
 ), original(n) AS(
  SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(roots)
  UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
 ) SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO original_keys FROM original;
 frame:=frame||jsonb_build_object('edges',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'[]'::jsonb) FROM jsonb_array_elements(source_nodes) n));
 IF original_keys IS NULL THEN RETURN jsonb_build_object('available',false,'reason','original_cohort');END IF;
 -- The complete all-version recording graph was checked before any payload.
 frame:=frame||jsonb_build_object('validUntil',deadline,'points','{}'::jsonb,'fields','{}'::jsonb,'scopes','{}'::jsonb,
  'sourceKeys',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) FROM jsonb_array_elements(source_nodes) n),
  'privacyCovered',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id'),true) FROM jsonb_array_elements(meta#>'{witness,privacyGraph,nodes}') n));
 IF meta->>'hasMemory'='true' THEN
  memory_context:=native_turn_empty_memory_context(w);
  IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' OR NOT(CASE
 WHEN NOT EXISTS(SELECT 1 FROM memories WHERE workspace_id=w) THEN true
 WHEN current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true' THEN
  application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)<=4096 AND coalesce(bool_and(private_row.user_id IS NOT NULL),false)
   FROM(SELECT user_id FROM memories WHERE workspace_id=w LIMIT 4097) private_row)
 ELSE false
END)
   OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w AND origin='{"kind":"native","moduleKey":"native"}' AND resource_type='memory')
   THEN RETURN jsonb_build_object('available',false,'reason','memory_requirements');END IF;
  memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows','{}'::jsonb,'cohort','[]'::jsonb));
 END IF;
 BEGIN
 FOR derivation IN SELECT value FROM jsonb_array_elements(meta#>'{witness,derivations}') LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',derivation->'user_id',
   'assistantId',derivation->'assistant_id','sensitivity',derivation->'sensitivity','compartments',derivation->'compartments','projectIds',derivation->'project_ids')) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 FOR key IN SELECT jsonb_array_elements_text(meta->'evaluationOrder') LOOP
  node:=nodes_by_key->key;
  IF node->>'tag'='point' THEN
   result:=native_turn_compact_point(w,node->>'kind',(node->>'id')::uuid,ARRAY(SELECT jsonb_array_elements_text(node->'fields')),memo,frame,scope_map);
   point_map:=point_map||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,coalesce(result->'value','null'::jsonb));
   -- Only the actual canonical-mask point may publish its query slot. An
   -- unsorted point never stands in for a not-yet-completed sorted peer.
   query_fields:=ARRAY(SELECT DISTINCT k FROM jsonb_array_elements_text(node->'fields') k ORDER BY k);
   IF node->'fields'=to_jsonb(query_fields) THEN
    query_envelope:=native_turn_compact_envelope(w,node->>'kind',(node->>'id')::uuid,'query',query_fields,memo,frame,point_map)->'value';
    query_envelope_values:=array_append(query_envelope_values,query_envelope);
    query_envelope_slots:=query_envelope_slots||jsonb_build_object(jsonb_build_array(node->>'kind',(node->>'id')::uuid,node->'fields')::text,cardinality(query_envelope_values));
   END IF;
  ELSIF node->>'kind'='application_field' THEN
   result:=native_retained_cached_field(w,(node->>'id')::uuid,node->>'version',memo,frame,point_map,field_map,query_envelope_slots,query_envelope_values);source:=result->'value';
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   field_map:=field_map||jsonb_build_object((node->>'id')||':'||(node->>'version'),source);
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   evidence_entries:=array_append(evidence_entries,jsonb_build_object('key',key,
    'immutable',observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version),
    'current',source-ARRAY['held','validTo','retractedAt']));END IF;
  ELSIF node->>'kind' IN('session_message','session_context_revision','workspace_file','episode','recording') THEN
   -- This complete acyclic schedule has already evaluated every dependency.
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(field_dependencies->key,'[]')) child
    WHERE field_map#>>ARRAY[(child->>'id')||':'||(child->>'version'),'held'] IS DISTINCT FROM 'false')
   THEN RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
   source:=frame#>ARRAY['currents',(node->>'kind')||':'||(node->>'id'),'source'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   scope_map:=scope_map||jsonb_build_object((node->>'kind')||':'||(node->>'id')||':'||(node->>'version'),true);
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',node->'kind','resourceId',node->'id','version',source->'version');
   IF original_keys ? ((node->>'kind')||':'||(node->>'id')||':'||(node->>'version')) THEN
   IF node->>'kind'='session_context_revision' AND source->>'version' IS DISTINCT FROM node->>'version' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   evidence_entries:=array_append(evidence_entries,jsonb_build_object('key',key,'current',source,
    'immutable',CASE WHEN node->>'kind'='session_context_revision' THEN source ELSE NULL END));END IF;
  END IF;
 END LOOP;
 -- Keep original identity separate from the current descriptor's version.
 -- The map contains only actual physical-source obligations, not semantic
 -- query candidates or versionless privacy-only admission dependencies.
 SELECT coalesce(jsonb_object_agg(e->>'key',e-'key'),'{}') INTO evidence_map FROM unnest(evidence_entries) e;
 FOR cohort IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
  WITH RECURSIVE physical(parent,child) AS MATERIALIZED(
   SELECT e.parent,e.child FROM native_retained_graph_edges(meta#>'{witness,graph}',false) e
   WHERE e.edge_kind IN('derivation','observation','observation_child','predecessor')
  ), original(n) AS(
   SELECT value||'{"tag":"source"}'::jsonb FROM jsonb_array_elements(cohort)
   UNION SELECT p.child FROM original o JOIN physical p ON p.parent=o.n
  ) SELECT coalesce(array_agg(native_turn_key(n)) FILTER(WHERE n->>'kind'<>'application_query_domain'),'{}')
   INTO cohort_keys FROM original;
  IF cardinality(cohort_keys)=0 OR EXISTS(SELECT 1 FROM unnest(cohort_keys) k WHERE NOT evidence_map ? k)
  THEN RAISE EXCEPTION 'native_turn_cohort_projection_missing' USING ERRCODE='42501';END IF;
  SELECT jsonb_build_object(
   'current',coalesce(jsonb_agg(evidence_map->k->'current' ORDER BY (evidence_map->k->'current')::text),'[]'),
   'immutable',coalesce(jsonb_agg(evidence_map->k->'immutable' ORDER BY (evidence_map->k->'immutable')::text)
    FILTER(WHERE evidence_map->k->'immutable' IS DISTINCT FROM 'null'::jsonb),'[]'))
   INTO packet FROM unnest(cohort_keys) k;
  cohort_packets:=cohort_packets||jsonb_build_array(packet);
 END LOOP;
 EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'PNT01' THEN
  RETURN jsonb_build_object('available',false,'reason','requirements_unavailable');
 END;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('available',true,'admitted',true,'validUntil',deadline,'cohorts',cohort_packets,
  'requirements',jsonb_build_object('nativeMetadata',meta#>'{witness,nativeMetadata}','sessionParents',meta#>'{witness,sessionParents}'));
END $function$
