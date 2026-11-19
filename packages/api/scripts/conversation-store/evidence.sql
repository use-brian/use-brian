CREATE FUNCTION capture_conversation_evidence(w uuid,roots jsonb,authority jsonb DEFAULT NULL,cohorts jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical jsonb;memo jsonb;n jsonb;source jsonb;immutable jsonb:='[]';currents jsonb:='[]';observation application_field_observations;key text;context jsonb;policy_revision jsonb;dependency record;authority_facts jsonb;groups jsonb;membership jsonb;cohort integer;proofs jsonb:='[]';selector record;candidate record;candidate_sources jsonb:='[]';attempts integer:=0;
BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 -- Cohorts are separate evidence floors in one physical capture. Their shared
 -- graph is evaluated once; membership never widens either returned floor.
 IF cohorts IS NOT NULL THEN
  IF roots IS NOT NULL OR authority IS NOT NULL OR jsonb_typeof(cohorts) IS DISTINCT FROM 'array'
   OR jsonb_array_length(cohorts)<>2 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  FOR groups IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
   IF jsonb_typeof(groups) IS DISTINCT FROM 'array' OR jsonb_array_length(groups) NOT BETWEEN 1 AND 4096
   THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
  END LOOP;
  SELECT jsonb_agg(DISTINCT item.node) INTO roots FROM jsonb_array_elements(cohorts) g CROSS JOIN jsonb_array_elements(g) item(node);
 END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096 THEN RETURN NULL;END IF;
 groups:=coalesce(cohorts,jsonb_build_array(roots));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) AS input(root) WHERE jsonb_typeof(input.root) IS DISTINCT FROM 'object' OR input.root-ARRAY['kind','id','version']<>'{}'
  OR NOT input.root ?& ARRAY['kind','id','version'] OR jsonb_typeof(input.root->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input.root->'version') IS DISTINCT FROM 'string' OR length(input.root->>'version') NOT BETWEEN 1 AND 256
  OR jsonb_typeof(input.root->'id') IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(input.root->>'id','uuid')) THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023';END IF;
 -- Query-domain identities are internal dependencies, never source roots.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root WHERE root->>'kind'='application_query_domain') THEN RETURN NULL;END IF;
 -- Source-family readers lock their native rows. Fence policy changes once
 -- across acquisition, without treating an uncommitted administrative lock as denial.
 SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 WITH RECURSIVE closure(cohort,kind,id,version) AS(
  SELECT g.position,r->>'kind',(r->>'id')::uuid,r->>'version'
   FROM jsonb_array_elements(groups) WITH ORDINALITY g(roots,position) CROSS JOIN jsonb_array_elements(g.roots) r
  UNION SELECT c.cohort,e.kind,e.id,e.version FROM closure c CROSS JOIN LATERAL conversation_source_edges(w,c.kind,c.id,c.version) e
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO membership FROM(SELECT * FROM closure LIMIT CASE WHEN cohorts IS NULL THEN 4097 ELSE 8193 END) c;
 IF jsonb_array_length(membership)>8192 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(DISTINCT member.node-'cohort'),'[]') INTO physical FROM jsonb_array_elements(membership) member(node);
 IF jsonb_array_length(physical)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501';END IF;
 IF cohorts IS NULL AND jsonb_array_length(roots)=1 AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(roots->0->>'id')::uuid
  AND roots->0->>'kind'='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  RETURN read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(roots->0->>'id')::uuid],ARRAY[roots->0->>'version']);
 END IF;
 -- Separate purpose/family adapters own independent source receipts and Memory
 -- history qualification. This operation does not speculate through those APIs.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x WHERE x->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','memory','workspace_file','episode','recording','private_transcript'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x JOIN application_field_resources f ON f.workspace_id=w AND f.id=(x->>'id')::uuid
   WHERE x->>'kind'='application_field' AND (f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR f.type_key NOT IN('session_message','session_message_annotation','memory') OR f.type_key='memory' AND f.selection='history'))
 THEN RETURN NULL;END IF;
 -- Stored result ancestry omits source-denied semantic candidates. Preserve
 -- the Memory family's complete-current-cohort discovery before claiming a
 -- native proof; metadata alone cannot substitute for external admission.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(physical) x JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=(x->>'id')::uuid WHERE x->>'kind'='application_field'
  AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain') THEN
  -- The canonical closure already owns ancestry. The old cohort facade
  -- walked it again through a 100-root API and refused larger valid captures.
  FOR selector IN SELECT DISTINCT q.domain FROM jsonb_to_recordset(physical) n(kind text,id uuid,version text)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id AND n.kind='application_field'
   JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=f.id AND o.version=n.version
   JOIN application_query_domains q ON q.workspace_id=w AND q.id=f.resource_id AND q.type_key=f.type_key AND q.origin=f.origin
   WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='query_domain' LOOP
   IF selector.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1' OR application_query_scope_valid(selector.domain->'bounds') IS NOT TRUE
   THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   IF selector.domain->>'includeRetained' IS DISTINCT FROM 'true' THEN CONTINUE;END IF;
   FOR candidate IN SELECT id FROM memories WHERE workspace_id=w ORDER BY id LOOP
    attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
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
 memo:=conversation_dag(w,roots,'[]');
 -- A denied semantic query candidate can become readable through an independent
 -- source. Its coordinator must reevaluate that complete candidate cohort.
 IF memo->>'hasExternal'='true' OR memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 FOR cohort IN 1..jsonb_array_length(groups) LOOP
 immutable:='[]';currents:='[]';
 FOR n IN SELECT x-'cohort' FROM jsonb_array_elements(membership) x WHERE (x->>'cohort')::integer=cohort LOOP
  IF n->>'kind'='application_query_domain' THEN CONTINUE;END IF;
  IF n->>'kind'='application_field' THEN
   source:=memo#>ARRAY['field:'||(n->>'id')||':'||(n->>'version'),'value'];
   IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
   SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(n->>'id')::uuid AND version=n->>'version';
   immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  ELSE
   IF memo#>>ARRAY['native:'||(n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),'value'] IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
   source:=memo#>ARRAY['current',(n->>'kind')||':'||(n->>'id')||':'||(n->>'version')];
   IF source IS NULL OR source='null'::jsonb THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
    'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind',n->'kind','resourceId',n->'id','version',source->'version');
   IF n->>'kind'='session_context_revision' THEN
    IF source->>'version' IS DISTINCT FROM n->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
    immutable:=immutable||jsonb_build_array(source);
   END IF;
  END IF;
  currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 proofs:=proofs||jsonb_build_array(jsonb_build_object('immutable',immutable,'current',currents));
 END LOOP;
 IF authority IS NOT NULL THEN
  IF jsonb_typeof(authority) IS DISTINCT FROM 'array' OR jsonb_array_length(authority)<>9
   OR authority->>0 IS DISTINCT FROM w::text OR authority->>1 IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  authority_facts:=read_session_authority_facts((authority->>0)::uuid,(authority->>1)::uuid,(authority->>2)::uuid,(authority->>3)::uuid,
    (authority->>4)::uuid,(authority->>5)::integer,(authority->>6)::uuid,(authority->>7)::boolean,(authority->>8)::boolean);
 END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;

 RETURN jsonb_build_object('admitted',true)||CASE WHEN cohorts IS NULL THEN proofs->0 ELSE jsonb_build_object('cohorts',proofs) END
  ||CASE WHEN authority IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('authority',authority_facts) END;
END $$;
REVOKE ALL ON FUNCTION capture_conversation_evidence(uuid,jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION capture_conversation_evidence(uuid,jsonb,jsonb,jsonb) TO app_user;
