-- [COMP:api/native-turn-frame] One bounded, bottom-up conversation evaluator.
CREATE OR REPLACE FUNCTION public.conversation_dag(w uuid, roots jsonb, selectors jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE seeds jsonb;nodes jsonb;edges jsonb;children jsonb;memo jsonb:='{}';slots jsonb;completed jsonb[];flat jsonb;privacy jsonb;
 current_node jsonb;k text;kind text;node_id uuid;node_version text;entity_id uuid;result jsonb;source jsonb;node_value jsonb;envelope jsonb;valid boolean;
 positions jsonb;reverse_edges jsonb;degree_map jsonb;degrees integer[];queue integer[]:='{}';cursor_index integer:=1;item integer;parent_index integer;node_count integer;
 resource application_field_resources;observation application_field_observations;fields text[];dependency record;policy jsonb;mask jsonb;type_key text;deadline timestamptz;
BEGIN
 SELECT coalesce(jsonb_agg(n),'[]') INTO seeds FROM(
  SELECT value||'{"tag":"source"}'::jsonb n FROM jsonb_array_elements(roots)
  UNION SELECT jsonb_build_object('tag','point','kind',q->>'type','id',m.id,'fields',
   (SELECT jsonb_agg(f ORDER BY f) FROM unnest(application_session_field_keys(q->>'type')) f))
  FROM jsonb_array_elements(selectors) q JOIN session_messages m ON m.workspace_id=w AND m.session_id=(q->>'sessionId')::uuid AND m.sequence_num<=(q->>'through')::integer
 ) selected;
 WITH RECURSIVE closure(n) AS(
  SELECT value FROM jsonb_array_elements(seeds)
  UNION SELECT e FROM closure c CROSS JOIN LATERAL conversation_dag_edges(w,c.n) e
 ) SELECT coalesce(jsonb_agg(n),'[]') INTO nodes FROM(SELECT n FROM closure LIMIT 4097) bounded;
 IF jsonb_array_length(nodes)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('parent',n,'child',e,'edge_kind','derivation')),'[]') INTO edges
 FROM (SELECT n,e FROM jsonb_array_elements(nodes) n CROSS JOIN LATERAL conversation_dag_edges(w,n) e LIMIT 65537) bounded_edges;
 IF jsonb_array_length(edges)>65536 OR pg_column_size(nodes)+pg_column_size(edges)>16777216 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 -- Intern the existing node set once. The old graph facade sorted, repacked
 -- and decoded the same nodes/edges before constructing this dependency queue.
 node_count:=jsonb_array_length(nodes);
 SELECT jsonb_object_agg(native_turn_key(n),position) INTO positions
 FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE native_turn_key(n) IS NULL)
  OR (SELECT count(*) FROM jsonb_object_keys(positions))<>node_count THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 WITH indexed AS MATERIALIZED(
  SELECT DISTINCT (positions->>native_turn_key(e->'parent'))::integer p,
   (positions->>native_turn_key(e->'child'))::integer c FROM jsonb_array_elements(edges) e
 ), reverse AS(SELECT c,jsonb_agg(p) parents FROM indexed GROUP BY c), degree AS(SELECT p,count(*) n FROM indexed GROUP BY p)
 SELECT (SELECT jsonb_object_agg(c,parents) FROM reverse),(SELECT jsonb_object_agg(p,n) FROM degree)
 INTO reverse_edges,degree_map;
 SELECT coalesce(array_agg(coalesce((degree_map->>i::text)::integer,0) ORDER BY i),'{}') INTO degrees FROM generate_series(1,node_count) i;
 FOR item IN 1..node_count LOOP IF degrees[item]=0 THEN queue:=array_append(queue,item);END IF;END LOOP;
 WHILE cursor_index<=cardinality(queue) LOOP
  item:=queue[cursor_index];cursor_index:=cursor_index+1;
  FOR parent_index IN SELECT value::integer FROM jsonb_array_elements_text(coalesce(reverse_edges->item::text,'[]')) LOOP
   degrees[parent_index]:=degrees[parent_index]-1;
   IF degrees[parent_index]=0 THEN queue:=array_append(queue,parent_index);END IF;
  END LOOP;
 END LOOP;
 IF cardinality(queue)<>node_count THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_object_agg(key,items),'{}') INTO children FROM(
  SELECT native_turn_key(e->'parent') key,jsonb_agg(e->'child') items FROM jsonb_array_elements(edges) e GROUP BY 1
 ) grouped;
 SELECT coalesce(min(t),'infinity'::timestamptz) INTO deadline FROM (
 SELECT expires_at t FROM department_edges WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM workspace_access_grants WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM workspace_access_grants WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM project_shared_members WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT starts_at FROM application_native_role_assignments WHERE starts_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM application_native_role_assignments WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT audience_deadlines.expires_at FROM (SELECT CASE WHEN pg_input_is_valid(binding->>'expiresAt','timestamp with time zone')
   THEN (binding->>'expiresAt')::timestamptz ELSE NULL END AS expires_at
  FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ci.config->'deliveryAudienceBindings')='array'
   THEN ci.config->'deliveryAudienceBindings' ELSE '[]'::jsonb END) binding
  WHERE c.workspace_id=w AND c.status='active' AND ci.status='active') audience_deadlines
  WHERE audience_deadlines.expires_at>transaction_timestamp()
 UNION ALL SELECT expires_at FROM external_source_authorizations
  WHERE workspace_id=w AND transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid()
   AND operation_id::text=nullif(current_setting('app.external_source_operation_id',true),'')
   AND observation_id IN(SELECT (n->>'id')::uuid FROM jsonb_array_elements(nodes) n
    WHERE n->>'kind'='external_source')
 UNION ALL SELECT to_timestamp((o.observation#>>'{retention,expiresAt}')::numeric/1000)
  FROM external_source_observations o JOIN jsonb_array_elements(nodes) n
   ON n->>'kind'='external_source' AND o.workspace_id=w AND o.id=(n->>'id')::uuid
  WHERE o.observation#>>'{retention,mode}'='released_snapshot') transitions;
 privacy:=conversation_capture_privacy(w,nodes);
 memo:=jsonb_build_object('privacyDenied',privacy->'denied','archiveDenied',privacy->'archiveDenied','recordingEligible',privacy->'recordingEligible','validUntil',deadline,'hasExternal',EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='external_source'),
  'points','{}'::jsonb,'domains','{}'::jsonb,'envelopes','{}'::jsonb,'current','{}'::jsonb);
 -- Expanded PostgreSQL arrays update completed slots without copying every
 -- earlier point, envelope and source at each graph vertex.
 SELECT jsonb_object_agg(label,slot) INTO slots FROM jsonb_array_elements(nodes) WITH ORDINALITY row(n,position)
 CROSS JOIN LATERAL (
  SELECT CASE WHEN n->>'tag'='point' THEN 'points:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   WHEN n->>'kind'='application_field' THEN 'field:'||(n->>'id')||':'||(n->>'version')
   WHEN n->>'kind'='application_query_domain' THEN 'domains:'||(n->>'id')
   ELSE 'native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END label,position*2-1 slot
  UNION ALL SELECT CASE WHEN n->>'tag'='point' THEN 'envelopes:'||jsonb_build_array(n->>'kind',n->>'id',n->'fields')::text
   ELSE 'current:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version') END,position*2
 ) aliases;
 completed:=array_fill(NULL::jsonb,ARRAY[jsonb_array_length(nodes)*2]);
 FOREACH item IN ARRAY queue LOOP
  current_node:=nodes->(item-1);k:=native_turn_key(current_node);kind:=current_node->>'kind';node_id:=(current_node->>'id')::uuid;node_version:=current_node->>'version';node_value:=NULL;source:=NULL;envelope:=NULL;
  IF current_node->>'tag'='point' THEN
   fields:=ARRAY(SELECT jsonb_array_elements_text(current_node->'fields'));
   IF NOT (memo->'privacyDenied') ? ('application_field:'||application_field_resource_uuid(application_field_digest(jsonb_build_object(
    'workspaceId',w,'origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',kind,'id',node_id,
    'selection','query','selectedVersion',NULL,'fields',fields,'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',kind,'fields',fields)))))) THEN
    result:=conversation_dag_point(w,kind,node_id,fields,memo,slots,completed);node_value:=result->'value';
   END IF;
   completed[(slots->>('points:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=node_value;
   envelope:=conversation_dag_envelope(w,kind,node_id,'query',fields,memo,slots,completed)->'value';
   completed[(slots->>('envelopes:'||jsonb_build_array(kind,node_id,fields)::text))::integer]:=envelope;
  ELSIF kind='application_field' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND application_field_resources.id=node_id;
   SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=node_id AND application_field_observations.version=node_version;
   IF resource.id IS NOT NULL AND observation.resource_id IS NOT NULL AND NOT scope_review_state_held('application_field',node_id) THEN
    IF resource.origin='{"kind":"native","moduleKey":"native"}' AND (resource.type_key IN('session_message','session_message_annotation')
     OR resource.type_key='memory' AND resource.selection IN('read','query','identity','query_domain')) THEN
     IF resource.selected_version IS NULL THEN
      envelope:=conversation_dag_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,slots,completed)->'value';
      valid:=envelope IS NOT NULL AND envelope->>'identity'=resource.identity
       AND (envelope#>>'{state,policyVersion}'=observation.policy_version
        OR resource.type_key='memory' AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version)
       AND workflow_evidence_envelope_visible(w,observation.source_scope) AND workflow_evidence_envelope_visible(w,envelope->'source');
      FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=node_id AND application_field_observation_sources.version=node_version LOOP
       IF dependency.source_kind='application_field' THEN source:=completed[(slots->>('field:'||dependency.source_id||':'||dependency.source_version))::integer]->'value';
       ELSE source:=completed[(slots->>('current:external_source:'||dependency.source_id||':'||dependency.source_version))::integer];END IF;
       IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR dependency.source_kind='external_source' AND source->>'version' IS DISTINCT FROM dependency.source_version THEN valid:=false;END IF;
      END LOOP;
      IF valid THEN node_value:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);END IF;
     END IF;
    ELSE node_value:=application_recorded_field_state_before_session_eval(w,node_id,node_version,0);END IF;
   END IF;
   completed[(slots->>('field:'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',node_value,'envelope',envelope,'external','[]'::jsonb);
  ELSIF kind='application_query_domain' THEN
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND resource_id=node_id AND selection='query_domain' LIMIT 1;
   IF resource.origin='{"kind":"native","moduleKey":"native"}' AND resource.type_key IN('session_message','session_message_annotation') THEN
    result:=conversation_dag_domain(w,resource.type_key,node_id,resource.fields,memo,slots,completed);
    completed[(slots->>('domains:'||node_id))::integer]:=result-'memo';
   END IF;
  ELSE
   valid:=true;
   IF (memo->'privacyDenied') ? (kind||':'||node_id) THEN valid:=false;
   ELSIF kind='external_source' THEN
    source:=external_source_snapshot(w,node_id);valid:=source IS NOT NULL AND source->>'held'='false' AND source->>'version'=node_version;
   ELSIF kind='session_message' THEN
    source:=conversation_message_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false'
     OR NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND id=node_id);
   ELSIF kind='session_context_revision' THEN
    source:=conversation_revision_snapshot(w,node_id,memo->'archiveDenied');valid:=source IS NOT NULL AND source->>'held'='false';
   ELSIF scope_source_table(kind) IS NOT NULL OR kind IN('private_transcript','crm_event','page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
    source:=read_admitted_native_scope_snapshot(w,kind,node_id);
    IF kind IN('session_context_revision','crm_event','private_transcript') AND source IS NULL OR source IS NOT NULL AND source->>'held' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    IF kind='private_transcript' AND source->>'version' IS DISTINCT FROM node_version THEN valid:=false;END IF;
   END IF;
   FOR dependency IN SELECT c FROM jsonb_array_elements(coalesce(children->k,'[]')) c WHERE c->>'tag'='source' LOOP
    IF dependency.c->>'kind'='application_field' THEN
     IF completed[(slots->>('field:'||(dependency.c->>'id')||':'||(dependency.c->>'version')))::integer]#>>'{value,held}' IS DISTINCT FROM 'false' THEN valid:=false;END IF;
    ELSIF dependency.c->>'kind'<>'application_query_domain' AND completed[(slots->>('native:'||(dependency.c->>'kind')||':'||(dependency.c->>'id')||':'||(dependency.c->>'version')))::integer]->>'value' IS DISTINCT FROM 'true' THEN valid:=false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=kind AND d.resource_id=node_id LOOP
    IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
     'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN valid:=false;END IF;
    FOR type_key,entity_id IN SELECT e.kind,e.id FROM scope_derivation_sources ds JOIN entities e ON e.workspace_id=w AND e.id=ds.source_id
     WHERE ds.workspace_id=w AND ds.derivation_id=dependency.id AND ds.source_kind='entity' AND e.kind IN('company','person','deal') LOOP
     policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id::text);
     IF policy->>'registered' IS DISTINCT FROM 'false' THEN
      mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,entity_id);
      IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
       OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN valid:=false;END IF;
     END IF;
    END LOOP;
   END LOOP;
   node_id:=(current_node->>'id')::uuid;
   completed[(slots->>('native:'||kind||':'||node_id||':'||node_version))::integer]:=jsonb_build_object('value',valid,'external','[]'::jsonb);
   completed[(slots->>('current:'||kind||':'||node_id||':'||node_version))::integer]:=source;
  END IF;
 END LOOP;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_object_agg(key,completed[value::integer]),'{}') INTO flat FROM jsonb_each_text(slots);
 SELECT memo||coalesce(jsonb_object_agg(key,value) FILTER(WHERE key LIKE 'field:%' OR key LIKE 'native:%'),'{}')
  ||jsonb_build_object(
   'points',coalesce(jsonb_object_agg(substring(key FROM 8),value) FILTER(WHERE key LIKE 'points:%'),'{}'),
   'envelopes',coalesce(jsonb_object_agg(substring(key FROM 11),value) FILTER(WHERE key LIKE 'envelopes:%'),'{}'),
   'domains',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'domains:%'),'{}'),
   'current',coalesce(jsonb_object_agg(substring(key FROM 9),value) FILTER(WHERE key LIKE 'current:%'),'{}'))
 INTO memo FROM jsonb_each(flat);
 RETURN memo;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag(uuid,jsonb,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_domain(w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;result jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;state jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN '{}'::jsonb;END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN '{}'::jsonb;END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN '{}'::jsonb;END IF;
 result:=conversation_dag_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,slots,completed);

 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN '{}'::jsonb;END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'children',result->'children');
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_edges(w uuid, n jsonb)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF n->>'tag'='source' THEN
 RETURN QUERY SELECT jsonb_build_object('tag','source','kind',e.kind,'id',e.id,'version',e.version)
 FROM conversation_source_edges(w,n->>'kind',(n->>'id')::uuid,n->>'version') e WHERE n->>'tag'='source'
 UNION SELECT jsonb_build_object('tag','point','kind',r.type_key,'id',r.resource_id,'fields',r.fields)
 FROM application_field_resources r WHERE n->>'tag'='source' AND n->>'kind'='application_field'
  AND r.workspace_id=w AND r.id=(n->>'id')::uuid AND r.origin='{"kind":"native","moduleKey":"native"}'
  AND r.type_key IN('session_message','session_message_annotation') AND r.selection IN('query','identity','read') AND r.selected_version IS NULL
 UNION SELECT jsonb_build_object('tag','point','kind',q.type_key,'id',m.id,'fields',q.domain->'fields')
 FROM application_query_domains q JOIN session_messages m ON m.workspace_id=w AND m.session_id=(q.domain->>'sessionId')::uuid
  AND m.sequence_num<=(q.domain->>'throughSequence')::integer
 WHERE n->>'tag'='source' AND n->>'kind'='application_query_domain' AND q.workspace_id=w AND q.id=(n->>'id')::uuid
  AND q.origin='{"kind":"native","moduleKey":"native"}' AND q.type_key IN('session_message','session_message_annotation')
 ;
 ELSE
 RETURN QUERY SELECT jsonb_build_object('tag','source','kind','session_message','id',m.id,'version',m.scope_version::text)
 FROM session_messages m WHERE n->>'tag'='point' AND m.workspace_id=w AND m.id=(n->>'id')::uuid
 UNION SELECT jsonb_build_object('tag','source','kind','session_context_revision','id',r.id,'version',r.scope_version::text)
 FROM session_message_annotation_heads h JOIN session_context_scope_revisions r ON r.workspace_id=w AND r.id=h.scope_revision_id
  AND r.session_id=h.session_id AND r.parent_kind='message_annotation' AND r.parent_id=h.message_id
 WHERE n->>'tag'='point' AND n->>'kind'='session_message_annotation' AND h.workspace_id=w AND h.message_id=(n->>'id')::uuid
;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_edges(uuid,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_envelope(w uuid, t text, i uuid, selection text, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF t NOT IN('session_message','session_message_annotation','memory') OR selection NOT IN('read','query','identity','query_domain') THEN RETURN '{}'::jsonb;END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN '{}'::jsonb;END IF;
 IF t='memory' THEN
  -- The family owns current selected fields, complete cohorts and successors.
  -- The DAG owns original field obligations; do not recursively capture them
  -- again through application_recorded_field_state_before_session_eval.
  state:=CASE WHEN selection='query_domain' THEN application_memory_query_domain_state(w,i,keys) ELSE application_memory_field_state(w,i,keys) END;
 ELSE
  IF selection='query_domain' THEN
   result:=completed[(slots->>('domains:'||i))::integer];children:=coalesce(result->'children','[]'::jsonb);
  ELSE result:=jsonb_build_object('value',completed[(slots->>('points:'||jsonb_build_array(t,i,keys)::text))::integer]);END IF;
  memo:=coalesce(result->'memo',memo);state:=result->'value';
 END IF;
 IF state IS NULL OR state='null'::jsonb THEN RETURN '{}'::jsonb;END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 IF coalesce(memo->>'hasExternal','true')='true' THEN
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN '{}'::jsonb;END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN '{}'::jsonb;END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_point(w uuid, t text, i uuid, fields text[], memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;checked jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean:=false;
 dependency record;admitted jsonb;projection jsonb;label jsonb;seen jsonb:='[]';immutable_scope jsonb;
BEGIN
 IF clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 -- Recording privacy admission precedes body selection.
 IF (memo->'privacyDenied') ? ('session_message:'||i) THEN RETURN '{}'::jsonb;END IF;
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Absence already returns NULL in the annotation branch below. Refuse it
 -- before the expensive parent proof, without changing scan identities or
 -- granting access. A present head still takes the original later head read,
 -- source admission and independent query-domain/currentness proofs.
 IF t='session_message_annotation' AND NOT EXISTS(
  SELECT 1 FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
  WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i
   AND r.parent_kind='message_annotation' AND r.parent_id=i AND r.session_id=m.session_id
 ) THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=completed[(slots->>('current:session_message:'||i||':'||m.scope_version))::integer];
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM m.scope_version::text
    THEN RETURN NULL;END IF;

  -- Only the first canonical history-bearing message uses complete per-original admission.
  IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources link ON link.workspace_id=d.workspace_id AND link.derivation_id=d.id
 CROSS JOIN LATERAL (
  SELECT link.source_kind,link.source_id,link.source_version WHERE link.source_kind<>'session_context_revision'
  UNION ALL
  SELECT edge.source_kind,edge.source_id,edge.source_version FROM native_turn_frames frame
   JOIN scope_derivations declaration ON declaration.workspace_id=frame.workspace_id
    AND declaration.resource_kind='session_context_revision' AND declaration.resource_id=frame.id AND declaration.resource_version='1'
   JOIN scope_derivation_sources edge ON edge.workspace_id=declaration.workspace_id AND edge.derivation_id=declaration.id
   WHERE link.source_kind='session_context_revision' AND link.source_version='1' AND frame.workspace_id=w
    AND frame.id=link.source_id AND frame.session_id=message.session_id AND frame.format=2
    AND (SELECT count(*) FROM scope_derivation_sources original WHERE original.workspace_id=w AND original.derivation_id=d.id)=1
    AND native_turn_frame_pair(w,frame.id) IS TRUE
 ) s
 WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=i) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

  END IF;
  IF history_shape IS TRUE THEN
   BEGIN
    IF application_reader_envelope_visible(w,source) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     SELECT o.source_scope INTO immutable_scope FROM application_field_observations o
      WHERE o.workspace_id=w AND o.resource_id=direct_ids[direct_position] AND o.version=direct_versions[direct_position];
     IF immutable_scope IS NULL OR workflow_evidence_envelope_visible(w,immutable_scope) IS NOT TRUE
      OR sensitivity_rank(immutable_scope->>'sensitivity')>sensitivity_rank(source->>'sensitivity')
      OR NOT (source->'compartments')@>(immutable_scope->'compartments') OR NOT (source->'projectIds')@>(immutable_scope->'projectIds')
      OR immutable_scope->>'userId' IS NOT NULL AND immutable_scope->>'userId' IS DISTINCT FROM source->>'userId'
       AND (source->>'userId' IS NOT NULL OR immutable_scope->>'userId' IS DISTINCT FROM actor::text)
      THEN RETURN '{}'::jsonb;END IF;
     IF EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
      projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]);
      IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
       OR projection->'root' IS DISTINCT FROM (immutable_scope||jsonb_build_object('resourceKind','application_field','resourceId',direct_ids[direct_position],'version',direct_versions[direct_position]))
       OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN RETURN '{}'::jsonb;END IF;
      FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
       IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
      END LOOP;
     ELSE
      -- Ordinary originals retain their stricter exact current-version check.
      admitted:=completed[(slots->>('field:'||direct_ids[direct_position]||':'||direct_versions[direct_position]))::integer]->'value';
      IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM direct_versions[direct_position]
       THEN RETURN '{}'::jsonb;END IF;
     END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     -- The helper admits the complete originals after metadata discovery.
     -- Transitive ordinary fields retain D1; their immutable tuple is not rewritten.
     IF dependency.source IS NULL OR dependency.source->>'resourceKind' IS DISTINCT FROM 'application_field'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
      OR NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w
       AND o.resource_id=(dependency.source->>'resourceId')::uuid AND o.version=dependency.node_version)
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE THEN RETURN '{}'::jsonb;END IF;
     seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
     IF jsonb_array_length(seen)>4096 THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT seen @> jsonb_build_array(jsonb_build_array(direct_ids[direct_position]::text,direct_versions[direct_position])) THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_external_source_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     admitted:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
     IF dependency.source IS NULL OR admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version OR admitted->>'version' IS DISTINCT FROM dependency.node_version
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE OR application_reader_envelope_visible(w,admitted) IS NOT TRUE
      THEN RETURN '{}'::jsonb;END IF;
    END LOOP;
    IF conversation_message_snapshot(w,i,memo->'archiveDenied') IS DISTINCT FROM source THEN RETURN '{}'::jsonb;END IF;
   EXCEPTION WHEN insufficient_privilege THEN RETURN '{}'::jsonb;END;
  ELSE
  checked:=conversation_dag_scope(w,'session_message',i,m.scope_version::text,memo,slots,completed);
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
  END IF;
  SELECT jsonb_build_object('id',id,'role',role,'content',content,'sequenceNum',sequence_num,'createdAt',created_at,
   'senderUserId',sender_user_id,'senderAssistantId',sender_assistant_id,'channelMessageId',channel_message_id,'attachments',attachments) INTO values_json
   FROM session_messages WHERE workspace_id=w AND id=i AND scope_version=m.scope_version;
  IF values_json IS NULL THEN RETURN NULL;END IF;
  source_kind:='session_message';source_id:=i;
  -- Selected payload changes remain distinct even when an old native writer
  -- changed text without advancing its scope envelope version.
  record_version:=m.scope_version::text||':'||application_field_digest(values_json);
 ELSE
  SELECT r.* INTO revision FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
   WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i AND r.parent_kind='message_annotation'
    AND r.parent_id=i AND r.session_id=m.session_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  checked:=conversation_dag_scope(w,'session_context_revision',revision.id,'1',memo,slots,completed);
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
  source:=(completed[(slots->>('current:session_context_revision:'||revision.id||':'||revision.scope_version))::integer])-'requiredSources';
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('value',jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_scan(w uuid, s uuid, t text, through integer, fields text[], bounds jsonb, visibility jsonb, memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;candidates jsonb;points jsonb;policies jsonb;children jsonb;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL THEN RETURN '{}'::jsonb;END IF;
 WITH selected AS MATERIALIZED(
  SELECT m.id,m.sequence_num,completed[(slots->>('envelopes:'||jsonb_build_array(t,m.id,fields)::text))::integer] point
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s AND m.sequence_num<=through
 ), admitted AS(
  SELECT * FROM selected q WHERE q.point IS NOT NULL AND q.point<>'null'::jsonb
   AND application_query_scope_admits_point(bounds,q.point->'source') IS TRUE
   AND(q.point#>>'{source,userId}' IS NULL OR q.point#>>'{source,userId}' IS NOT DISTINCT FROM visibility->>'userId')
   AND(q.point#>>'{source,assistantId}' IS NULL OR visibility->'assistants'='null'::jsonb
    OR coalesce(visibility->'assistants' ? (q.point#>>'{source,assistantId}'),false))
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'policy',point#>'{state,policyVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(point ORDER BY sequence_num,id),'[]') INTO candidates,points,policies,children FROM admitted;
 RETURN jsonb_build_object('value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);
END $function$;
REVOKE ALL ON FUNCTION conversation_dag_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_dag_scope(w uuid, k text, i uuid, v text, memo jsonb, slots jsonb, completed jsonb[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('value',coalesce(completed[(slots->>('native:'||k||':'||i||':'||v))::integer]->>'value'='true',false))
$function$;
REVOKE ALL ON FUNCTION conversation_dag_scope(uuid,text,uuid,text,jsonb,jsonb,jsonb[]) FROM PUBLIC,app_user;

