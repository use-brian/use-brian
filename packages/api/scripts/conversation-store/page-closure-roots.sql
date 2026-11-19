
DECLARE memo jsonb;n jsonb;source jsonb;required jsonb;immutable jsonb:='[]';currents jsonb:='[]';observation application_field_observations;
 context jsonb;policy_revision jsonb;membership jsonb;lineage jsonb;dependency record;selector record;candidate record;candidate_sources jsonb:='[]';attempts integer:=0;
 page_kinds constant text[]:=ARRAY['page_event_changed','page_event_destination','page_live_changed','page_live_destination'];
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  -- Two-role model: an owner, superuser or BYPASSRLS login, or a call without a
  -- principal, never obtains an admission here. Decline (8287) so the caller's
  -- full validator decides, as it did before Page roots reached this member.
  RETURN NULL;END IF;
 -- The receiving principal must be the caller ceiling's own user (read_admitted_page_authority's precondition).
 IF actor IS NULL OR actor::text IS DISTINCT FROM current_setting('app.current_user_id',true)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object' OR input.root-ARRAY['kind','id','version']<>'{}'
  OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid')) THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 -- Page receipts may be roots (a doc-thread turn reads its current Page) or be reached through
 -- derivation edges; either way each is admitted below for this principal now. Query-domain
 -- roots keep their owner.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root WHERE root->>'kind'='application_query_domain'
  OR root->>'kind' NOT IN('application_field','session_message','session_context_revision','memory','workspace_file','private_transcript')
   AND NOT root->>'kind'=ANY(page_kinds)) THEN RETURN NULL;END IF;
 SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 WITH RECURSIVE closure(kind,id,version) AS(
  SELECT r->>'kind',(r->>'id')::uuid,r->>'version' FROM jsonb_array_elements(roots) r
  UNION SELECT e.kind,e.id,e.version FROM closure c CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO membership FROM(SELECT * FROM closure LIMIT 4097) c;
 IF jsonb_array_length(membership)>4096 THEN RETURN NULL;END IF;
 -- Only closures that reach a Page receipt belong to this family; the ordinary capture owns the rest.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(membership) x WHERE x->>'kind'=ANY(page_kinds)) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(membership) x WHERE x->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','memory','workspace_file','episode','recording','private_transcript')
   AND NOT x->>'kind'=ANY(page_kinds))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(membership) x JOIN application_field_resources f ON f.workspace_id=w AND f.id=(x->>'id')::uuid
   WHERE x->>'kind'='application_field' AND (f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR f.type_key NOT IN('session_message','session_message_annotation','memory') OR f.type_key='memory' AND f.selection='history'))
 THEN RETURN NULL;END IF;
 -- Stored result ancestry omits source-denied semantic candidates. Preserve
 -- the Memory family's complete-current-cohort discovery before claiming a
 -- native proof; metadata alone cannot substitute for external admission.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(membership) x JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=(x->>'id')::uuid WHERE x->>'kind'='application_field'
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain') THEN
  -- The canonical closure already owns ancestry. The old cohort facade
  -- walked it again through a 100-root API and refused larger valid captures.
  FOR selector IN SELECT DISTINCT q.domain FROM jsonb_to_recordset(membership) n(kind text,id uuid,version text)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
   JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
   JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain' LOOP
   IF selector.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE
   THEN RETURN NULL;END IF;
   IF selector.domain->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
   FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP
    attempts:=attempts+1;IF attempts>4096 THEN RETURN NULL;END IF;
    source:=read_scope_source(w,'memory',candidate.id);
    IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR application_query_scope_admits_point(selector.domain->'bounds',source) IS NOT TRUE THEN CONTINUE;END IF;
    candidate_sources:=candidate_sources||jsonb_build_array(jsonb_build_object('kind','memory','id',candidate.id,'version',source->'version'));
   END LOOP;
  END LOOP;
  FOR dependency IN SELECT array_agg(cohort_source.node->>'kind') kinds,
   array_agg((cohort_source.node->>'id')::uuid) ids,array_agg(cohort_source.node->>'version') versions
   FROM jsonb_array_elements(candidate_sources) WITH ORDINALITY cohort_source(node,ord)
   GROUP BY (cohort_source.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;
 -- The source validator discovers Page dependencies through canonical scope lineage.
 -- Both walks must name the same Page receipts, or this adapter declines.
 SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('kind',l.kind,'id',l.id,'version',l.version)),'[]') INTO lineage
  -- The lineage reader takes at most 100 roots per call; the union of per-chunk
  -- lineages is the lineage of all roots (8278 refused larger turns instead).
  FROM (SELECT array_agg(x.r->>'kind' ORDER BY x.ord) kinds,array_agg((x.r->>'id')::uuid ORDER BY x.ord) ids,array_agg(x.r->>'version' ORDER BY x.ord) versions
   FROM jsonb_array_elements(roots) WITH ORDINALITY x(r,ord) GROUP BY (x.ord-1)/100) chunk
  CROSS JOIN LATERAL application_scope_lineage(w,chunk.kinds,chunk.ids,chunk.versions) l WHERE l.kind=ANY(page_kinds);
 IF lineage IS DISTINCT FROM (SELECT coalesce(jsonb_agg(DISTINCT x),'[]') FROM jsonb_array_elements(membership) x WHERE x->>'kind'=ANY(page_kinds)) THEN RETURN NULL;END IF;
 memo:=conversation_dag(w,roots,'[]');
 IF memo->>'hasExternal'='true' OR memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(membership) LOOP
  IF n->>'kind'='application_query_domain' THEN CONTINUE;END IF;
  IF n->>'kind'='application_field' THEN
   source:=memo#>ARRAY['field:'||(n->>'id')||':'||(n->>'version'),'value'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(n->>'id')::uuid AND version=n->>'version';
   immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  ELSIF n->>'kind'=ANY(page_kinds) THEN
   -- A Page receipt is never a D1 deletion: it must be admitted for this principal now.
   IF memo#>>ARRAY['native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'value'] IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
   source:=memo#>ARRAY['current',(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')];
   IF source IS NULL OR jsonb_typeof(source) IS DISTINCT FROM 'object' OR source->>'held' IS DISTINCT FROM 'false'
    OR source->>'resourceKind' IS DISTINCT FROM n->>'kind' OR source->>'resourceId' IS DISTINCT FROM n->>'id' OR source->>'version' IS DISTINCT FROM n->>'version'
    OR source->>'workspaceId' IS DISTINCT FROM w::text OR jsonb_typeof(source->'requiredSources') IS DISTINCT FROM 'array' OR jsonb_array_length(source->'requiredSources')=0
   THEN RETURN NULL;END IF;
   FOR required IN SELECT value FROM jsonb_array_elements(source->'requiredSources') LOOP
    IF jsonb_typeof(required) IS DISTINCT FROM 'object' OR required->>'workspaceId' IS DISTINCT FROM w::text OR NOT required->>'resourceKind'=ANY(page_kinds) THEN RETURN NULL;END IF;
    currents:=currents||jsonb_build_array(jsonb_build_object('workspaceId',w,'userId',required->'userId','assistantId',required->'assistantId','sensitivity',required->'sensitivity',
     'compartments',required->'compartments','projectIds',required->'projectIds','resourceKind',required->'resourceKind','resourceId',required->'resourceId','version',required->'version'));
   END LOOP;
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
  ELSE
   IF memo#>>ARRAY['native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'value'] IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
   -- An ordinary ancestor of a Page receipt must carry an admitted derivation source (read_admitted_page_dependencies).
   IF n->>'kind' IN('session_context_revision','application_field') AND read_scope_source(w,n->>'kind',(n->>'id')::uuid) IS NOT NULL
    AND read_entity_derivation_source(w,n->>'kind',(n->>'id')::uuid) IS NULL THEN RETURN NULL;END IF;
   source:=memo#>ARRAY['current',(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')];
   IF source IS NULL OR source='null'::jsonb THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
   IF n->>'kind'='session_context_revision' THEN
    IF source->>'version' IS DISTINCT FROM n->>'version' THEN RETURN NULL;END IF;
    immutable:=immutable||jsonb_build_array(source);
   END IF;
  END IF;
  currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END 