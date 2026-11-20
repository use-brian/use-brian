-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.conversation_prepare_publications(w uuid,s uuid,commands jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb;retained jsonb:='[]';dependency record;
 command jsonb;compiled jsonb:='[]';results jsonb:='[]';producer text;sources jsonb;target jsonb;
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;source_scope jsonb;projection jsonb;label jsonb;
 lineage jsonb;
 result jsonb;deadline timestamptz;privacy jsonb;seeds jsonb;frontier jsonb;edges jsonb:='[]';batch jsonb;
BEGIN

 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(commands) IS DISTINCT FROM 'array' OR jsonb_array_length(commands) NOT BETWEEN 1 AND 2
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR command IN SELECT value FROM jsonb_array_elements(commands) LOOP
  IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR command-ARRAY['producer','sources','target','purpose']<>'{}'
   OR command ? 'purpose' AND command->>'purpose' IS DISTINCT FROM 'session_title'
   OR NOT command ?& ARRAY['producer','sources','target'] OR jsonb_typeof(command->'producer') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  producer:=command->>'producer';sources:=command->'sources';target:=command->'target';expanded:=sources;
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
 THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(node->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(node->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(node->'version') IS DISTINCT FROM 'string' OR length(btrim(node->>'version')) NOT BETWEEN 1 AND 256
   OR node->>'resourceKind' NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 WITH RECURSIVE closure(kind,id,version,ordinary) AS (
  SELECT n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version',NOT EXISTS(
   SELECT 1 FROM application_field_resources f WHERE n->>'resourceKind'='application_field'
    AND f.workspace_id=w AND f.id=(n->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
  FROM jsonb_array_elements(sources) n
  UNION SELECT e.kind,e.id,e.version,c.ordinary FROM closure c
   CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ), bounded AS MATERIALIZED(SELECT * FROM closure LIMIT 8193), distinct_nodes AS(
  SELECT kind,id,version,bool_or(ordinary) ordinary FROM bounded GROUP BY kind,id,version
 ) SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO lineage FROM distinct_nodes n;
 IF jsonb_array_length(lineage)>4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(lineage) n
  WHERE n->>'kind' IS NULL OR n->>'id' IS NULL OR n->>'version' IS NULL
   OR n->>'kind'='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'))
 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 FOR dependency IN
  WITH history_roots AS MATERIALIZED(
   SELECT original.value FROM jsonb_array_elements(sources) original(value)
   JOIN application_field_resources f ON original.value->>'resourceKind'='application_field'
    AND f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'
  )
  SELECT DISTINCT node_version,source FROM (
   SELECT d.node_version,d.source FROM history_roots original
   CROSS JOIN LATERAL read_native_session_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   UNION ALL SELECT n->>'version',o.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',o.resource_id,'version',o.version)
    FROM jsonb_array_elements(lineage) n LEFT JOIN application_field_observations o
     ON o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
    WHERE n->>'kind'='application_field' AND n->>'ordinary'='true'
   UNION ALL SELECT n->>'version',CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
    'workspaceId',o.workspace_id,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',o.id,'version',o.version,
    'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids) END
    FROM jsonb_array_elements(lineage) n LEFT JOIN external_source_observations o ON o.workspace_id=w AND o.id=(n->>'id')::uuid
    WHERE n->>'kind'='external_source'
   UNION ALL SELECT n->>'version',read_scope_source(w,n->>'kind',(n->>'id')::uuid)
    FROM jsonb_array_elements(lineage) n WHERE n->>'kind'='session_context_revision'
  ) obligations
 LOOP
  node:=dependency.source;
  IF node IS NULL OR node->>'held'='true' OR node->>'version' IS DISTINCT FROM dependency.node_version
   OR entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  node:=jsonb_build_object('workspaceId',node->'workspaceId','userId',node->'userId','assistantId',node->'assistantId',
   'sensitivity',node->'sensitivity','compartments',node->'compartments','projectIds',node->'projectIds',
   'resourceKind',node->'resourceKind','resourceId',node->'resourceId','version',node->'version');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')
   AND (original->>'version' IS DISTINCT FROM node->>'version' OR (original-ARRAY['held','validTo','retractedAt','causalEntityId']) IS DISTINCT FROM node)) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')) THEN
   expanded:=expanded||jsonb_build_array(node);END IF;
  IF jsonb_array_length(expanded)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (candidate.value->>'resourceKind',candidate.value->>'resourceId')) FROM jsonb_array_elements(expanded) candidate(value))<>jsonb_array_length(expanded) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  compiled:=compiled||jsonb_build_array(command||jsonb_build_object('expanded',expanded));
 END LOOP;
 -- One physical acquisition owns both cohorts. Original descriptors and labels
 -- stay separate; sharing graph vertices never widens a cohort's lineage.
 memo:=conversation_dag(w,(SELECT jsonb_agg(root ORDER BY root::text) FROM (
  SELECT DISTINCT jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId','version',n->>'version') root
  FROM jsonb_array_elements(compiled) c CROSS JOIN LATERAL jsonb_array_elements(c->'expanded') n
 ) roots),'[]');
 FOR command IN SELECT value FROM jsonb_array_elements(compiled) LOOP
  producer:=command->>'producer';sources:=command->'sources';target:=command->'target';expanded:=command->'expanded';
  retained:='[]';edges:='[]';
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 -- The owning writer or independent completion operation authenticates the
 -- complete helper contract before entry and again before releasing its effect.
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   current_source:=memo#>ARRAY['field:'||(node->>'resourceId')||':'||(node->>'version'),'value'];
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE
   current_source:=NULLIF(memo#>ARRAY['current',(node->>'resourceKind')||':'||(node->>'resourceId')||':'||(node->>'version')],'null'::jsonb);
   IF memo#>>ARRAY['native:'||(node->>'resourceKind')||':'||(node->>'resourceId')||':'||(node->>'version'),'value'] IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF (command->>'purpose'='session_title' OR node->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript'))
   AND (current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version'
    OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
      IS DISTINCT FROM (node->'workspaceId',node->'userId',node->'assistantId',node->'sensitivity')
    OR NOT (current_source->'compartments')@>(node->'compartments') OR NOT (node->'compartments')@>(current_source->'compartments')
    OR NOT (current_source->'projectIds')@>(node->'projectIds') OR NOT (node->'projectIds')@>(current_source->'projectIds')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='crm_event' AND (current_source IS NULL OR current_source->>'version' IS DISTINCT FROM node->>'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) e WHERE e->>'resourceKind'='entity' AND e->>'resourceId'=current_source->>'causalEntityId')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) original WHERE
    (original->>'resourceKind',original->>'resourceId',original->>'version')=(node->>'resourceKind',node->>'resourceId',node->>'version'))
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(node->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(node->>'resourceId')::uuid],ARRAY[node->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt'])
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM target->>'userId'
      AND (target->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(node->>'resourceId')::uuid,node->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt']) THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF sensitivity_rank(node->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=node->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(node->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(node->'projectIds')::uuid)) value ORDER BY value);
  IF current_source IS NOT NULL AND current_source->>'validTo' IS NULL AND current_source->>'retractedAt' IS NULL THEN
   IF sensitivity_rank(current_source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=current_source->>'sensitivity';END IF;
   teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(current_source->'compartments'))) value ORDER BY value);
   projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(current_source->'projectIds')::uuid)) value ORDER BY value);
   IF current_source->>'version'=node->>'version' AND (current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS NOT DISTINCT FROM (node->'userId',node->'assistantId',node->'sensitivity') AND current_source->'compartments'=node->'compartments'
    AND current_source->'projectIds'=node->'projectIds' THEN retained:=retained||jsonb_build_array(node);END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) obligation(value)
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);

 result:=jsonb_build_object('scope',source_scope,'retained',retained)
  ||CASE WHEN command ? 'purpose' THEN jsonb_build_object('purpose',command->'purpose') ELSE '{}'::jsonb END;
 SELECT jsonb_agg(DISTINCT jsonb_build_object('kind',n->>'resourceKind','id',n->>'resourceId')) INTO seeds
 FROM jsonb_array_elements(sources) n;
 frontier:=seeds;
 WHILE jsonb_array_length(frontier)>0 LOOP
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.parent::text,e.child::text),'[]') INTO batch
  FROM native_turn_privacy_edges(w,frontier) e;
  edges:=edges||batch;
  SELECT coalesce(jsonb_agg(DISTINCT e->'child'),'[]') INTO frontier FROM jsonb_array_elements(batch) e
  WHERE NOT seeds @> jsonb_build_array(e->'child');
  seeds:=seeds||frontier;
  IF jsonb_array_length(seeds)>4096 OR jsonb_array_length(edges)>65536 THEN
   RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 privacy:=jsonb_build_object('nodes',(SELECT jsonb_agg(n ORDER BY n::text) FROM jsonb_array_elements(seeds) n),
  'edges',(SELECT coalesce(jsonb_agg(e ORDER BY e::text),'[]') FROM jsonb_array_elements(edges) e));
 -- The independently fresh completion pass compares all-version adjacency,
 -- including ancestors added to an older observation during publication.
 result:=result||jsonb_build_object('privacy',privacy);
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
   AND observation_id IN(SELECT (n->>'resourceId')::uuid FROM jsonb_array_elements(result->'retained') n
    WHERE n->>'resourceKind'='external_source')
 UNION ALL SELECT to_timestamp((o.observation#>>'{retention,expiresAt}')::numeric/1000)
  FROM external_source_observations o JOIN jsonb_array_elements(result->'retained') n
   ON n->>'resourceKind'='external_source' AND o.workspace_id=w AND o.id=(n->>'resourceId')::uuid
  WHERE o.observation#>>'{retention,mode}'='released_snapshot') transitions;
 IF clock_timestamp()>=deadline THEN RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
  results:=results||jsonb_build_array(result||jsonb_build_object('proof',jsonb_build_object('validUntil',deadline)));
 END LOOP;
 RETURN results;
END $body$;

REVOKE ALL ON FUNCTION conversation_prepare_publications(uuid,uuid,jsonb) FROM PUBLIC,app_user;
