-- [COMP:api/native-turn-frame] Page source-family adapter of the native capture (8278).
-- The ordinary capture declines every closure that reaches a Page receipt. This
-- member admits exactly those closures whose only non-native family is Page
-- receipts reached through derivation edges, for the caller's own principal,
-- under the two-role model (an ordinary owner defines it; only app_user calls
-- it, with the transaction's own user as `actor`). It returns the capture's
-- result shape with every Page receipt and its saved and current boundaries as
-- current obligations, or NULL whenever it does not own or cannot prove the
-- closure; the caller's complete source validator then decides, including every
-- refusal. Nothing is stored and no result crosses the statement.
CREATE FUNCTION public.capture_page_closure_evidence(w uuid,roots jsonb,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE memo jsonb;n jsonb;source jsonb;required jsonb;immutable jsonb:='[]';currents jsonb:='[]';observation application_field_observations;
 context jsonb;policy_revision jsonb;membership jsonb;lineage jsonb;dependency record;selector record;candidate record;candidate_sources jsonb:='[]';attempts integer:=0;
 page_kinds constant text[]:=ARRAY['page_event_changed','page_event_destination','page_live_changed','page_live_destination'];
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 -- The receiving principal must be the caller ceiling's own user (read_admitted_page_authority's precondition).
 IF actor IS NULL OR actor::text IS DISTINCT FROM current_setting('app.current_user_id',true)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object' OR input.root-ARRAY['kind','id','version']<>'{}'
  OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid')) THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 -- Page receipts reached only through derivation edges; Page and query-domain roots keep their owners.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root WHERE root->>'kind'='application_query_domain' OR root->>'kind'=ANY(page_kinds)
  OR root->>'kind' NOT IN('application_field','session_message','session_context_revision','memory','workspace_file','private_transcript')) THEN RETURN NULL;END IF;
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
  FROM application_scope_lineage(w,ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(roots) r),ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(roots) r),
   ARRAY(SELECT r->>'version' FROM jsonb_array_elements(roots) r)) l WHERE l.kind=ANY(page_kinds);
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
END $body$;
REVOKE ALL ON FUNCTION public.capture_page_closure_evidence(uuid,jsonb,uuid) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_page_closure_evidence(uuid,jsonb,uuid) TO app_user;

-- Successor of migration 725's read_page_event_authority. Identical result; the
-- table-wide SHARE lock on teamspace_members becomes KEY SHARE row locks on
-- exactly the (Teamspace, actor) memberships the principal check reads.
CREATE OR REPLACE FUNCTION public.read_page_event_authority(w uuid,receipt_id uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE receipt workflow_page_event_receipts; item record; live saved_views;
 current_boundary jsonb; projections jsonb:='[]'; allowed boolean;
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 SELECT * INTO receipt FROM workflow_page_event_receipts
  WHERE workspace_id=w AND revision=receipt_id FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOR item IN SELECT key,value FROM jsonb_each(receipt.boundaries)
  WHERE key='changed' OR receipt.metadata->>'action' IN ('created','moved') ORDER BY key LOOP
  -- Lock the membership edge before the principal check reads it: removal waits
  -- for this transaction, and a removal committed first is seen as absent.
  -- A missing edge is a denial; a concurrent insert can only widen, never stale-grant.
  IF item.value->>'principalBoundary'='teamspace' AND pg_input_is_valid(item.value->>'teamspaceId','uuid') THEN
   PERFORM 1 FROM teamspace_members WHERE teamspace_id=(item.value->>'teamspaceId')::uuid AND user_id=actor FOR KEY SHARE;
  END IF;
  allowed:=page_event_principal_allows(w,actor,item.value);
  SELECT * INTO live FROM saved_views WHERE workspace_id=w AND id=(item.value->>'pageId')::uuid FOR SHARE;
  current_boundary:=NULL;
  IF FOUND THEN
   current_boundary:=workflow_page_event_boundary(live);
   IF current_boundary->>'principalBoundary'='teamspace' AND pg_input_is_valid(current_boundary->>'teamspaceId','uuid') THEN
    PERFORM 1 FROM teamspace_members WHERE teamspace_id=(current_boundary->>'teamspaceId')::uuid AND user_id=actor FOR KEY SHARE;
   END IF;
   allowed:=allowed AND page_event_principal_allows(w,actor,current_boundary);
  END IF;
  projections:=projections||jsonb_build_array(jsonb_build_object('role',item.key,
   'saved',item.value,'current',current_boundary,'principalAllowed',allowed,
   'savedSource',page_event_scope_descriptor(receipt_id,item.key,item.value,false),
   'currentSource',capture_page_event_observation(w,receipt_id,item.key,current_boundary)));
 END LOOP;
 RETURN jsonb_build_object('metadata',receipt.metadata,'boundaries',projections);
END $body$;
REVOKE ALL ON FUNCTION public.read_page_event_authority(uuid,uuid,uuid) FROM PUBLIC;
