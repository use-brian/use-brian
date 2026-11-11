-- [COMP:api/application-persistence] Complete invocation-local private title proof.
-- No persisted proof, caller memo, permission cache, or alteration of old lanes.
BEGIN;
DO $predecessor$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['application_native_worklist_helpers_current()',
  'application_memory_statement_helpers_current()','application_empty_query_helpers_current()',
  'native_turn_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'private_title_predecessor_changed: %',signature;END IF;
 END LOOP;
END $predecessor$;

-- These three postdate the old closed proof's manifest. Authenticate their
-- canonical 8203/8234 bodies AND complete normalized catalog metadata before
-- taking installation-local fingerprints; never bless pre-upgrade drift.
DO $transcript_predecessor$
DECLARE routine record;p pg_proc;metadata jsonb;expected jsonb;owner_id oid;
 common jsonb:='{"probin":null,"procost":100,"prokind":"f","prorows":0,"proretset":false,
  "prosqlbody":null,"prosupport":"-","proargmodes":null,"proisstrict":false,"proparallel":"u",
  "protrftypes":null,"provariadic":"0","proleakproof":false,"proallargtypes":null,
  "proargdefaults":null,"pronargdefaults":0}';
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.private_transcript_observations'::regclass;
 FOR routine IN SELECT * FROM (VALUES
  ('private_legacy_history_binding(sessions)','ede88958a8c91058b31a37cb1fb64c863ee1009027f7afce094f5b38e72a2c21',
   'sql',false,'i','jsonb','["s"]'::jsonb,'["search_path=pg_catalog, public, pg_temp"]'::jsonb),
  ('private_transcript_message_fingerprint(session_messages)','bb8dd79fc59b9ecd69574df3694ebfd2a089c305e8ce0dd4e26cca740e387976',
   'sql',false,'i','text','["m"]'::jsonb,'["search_path=pg_catalog, public, pg_temp","TimeZone=UTC"]'::jsonb),
  ('read_private_transcript_source(uuid,uuid)','0ea4bea3329e6b665a92e25e2077eebb911ea7995c2102357da7aa6bfcc959db',
   'plpgsql',true,'v','jsonb','["w","i"]'::jsonb,'["search_path=pg_catalog, public, pg_temp"]'::jsonb)
 ) contract(signature,body_hash,language,security_definer,volatility,return_type,argnames,config) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||routine.signature);
  metadata:=to_jsonb(p)-ARRAY['oid','pronamespace','proowner','prolang','proargtypes','prosrc','proacl'];
  expected:=common||jsonb_build_object('proname',split_part(routine.signature,'(',1),'pronargs',jsonb_array_length(routine.argnames),
   'prosecdef',routine.security_definer,'provolatile',routine.volatility,'prorettype',(routine.return_type::regtype::oid)::text,
   'proargnames',routine.argnames,'proconfig',routine.config);
  IF p.pronamespace<>'public'::regnamespace OR p.proowner<>owner_id
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=routine.language)
   OR metadata IS DISTINCT FROM expected OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM routine.body_hash
   OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=owner_id AND a.grantor=owner_id
    AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) IS NOT TRUE
  THEN RAISE EXCEPTION 'private_title_transcript_predecessor_changed: %',routine.signature;END IF;
 END LOOP;
END $transcript_predecessor$;

CREATE FUNCTION native_private_title_helpers_current() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RETURN false; END $$;
REVOKE ALL ON FUNCTION native_private_title_helpers_current() FROM PUBLIC;

-- The ordinary seed's closed kind list predates private_transcript. Preserve
-- every node/edge and ordinary reader, admitting transcript leaves explicitly.
CREATE FUNCTION native_private_title_frame(w uuid,nodes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frame jsonb;edges jsonb;currents jsonb:='{}';node record;source jsonb;context jsonb;
BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF w IS NULL OR jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes) NOT BETWEEN 1 AND 4096
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE ((n->>'kind') IN('application_field','application_query_domain','session_message','session_context_revision','memory','private_transcript')
   AND (n->>'id') IS NOT NULL AND (n->>'version') IS NOT NULL) IS NOT TRUE) THEN RETURN NULL;END IF;
 edges:=native_worklist_edges(w,nodes);
 IF edges IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(edges) parent CROSS JOIN LATERAL jsonb_array_elements(parent.value) child
  WHERE NOT edges ? ((child->>'kind')||':'||(child->>'id')||':'||(child->>'version'))) THEN RETURN NULL;END IF;
 context:=native_worklist_context(w,nodes);
 frame:=jsonb_build_object('workspaceId',w,'closed',true,'nodes',nodes,'edges',edges,'context',context,'currents',currents);
 FOR node IN SELECT DISTINCT (n->>'kind') kind,((n->>'id'))::uuid id FROM jsonb_array_elements(nodes) n
  WHERE (n->>'kind') IN('session_message','session_context_revision','memory','private_transcript') ORDER BY kind,id LOOP
  IF node.kind='private_transcript' THEN
   -- Owner-gated dispatch, then the same envelope/visibility/review gates as
   -- ordinary native current admission. Private leaves are immutable version 1.
   source:=read_entity_derivation_source(w,node.kind,node.id);
   IF source IS NULL OR source->>'workspaceId' IS DISTINCT FROM w::text
    OR source->>'resourceKind' IS DISTINCT FROM node.kind OR source->>'resourceId' IS DISTINCT FROM node.id::text
    OR source->>'version' IS DISTINCT FROM '1' OR source->>'held' IS DISTINCT FROM 'false'
    OR source->>'userId' IS DISTINCT FROM current_setting('app.current_user_id',true)
    OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
    OR jsonb_typeof(source->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(source->'projectIds') IS DISTINCT FROM 'array'
    OR source->>'sensitivity' NOT IN('public','internal','confidential')
    OR scope_review_state_held(node.kind,node.id) IS TRUE
    OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE
    OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN NULL;END IF;
  ELSE source:=native_worklist_current(w,node.kind,node.id,frame);END IF;
  currents:=currents||jsonb_build_object(node.kind||':'||node.id,jsonb_build_object('kind',node.kind,'id',node.id,'source',source));
 END LOOP;
 IF application_native_worklist_helpers_current() IS NOT TRUE OR native_worklist_context(w,nodes) IS DISTINCT FROM context THEN RETURN NULL;END IF;
 RETURN jsonb_set(frame,'{currents}',currents);
END $$;
REVOKE ALL ON FUNCTION native_private_title_frame(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION native_private_title_proof(w uuid,s uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 assistant uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 kinds text[]:=ARRAY['session_context_revision'];ids uuid[]:=ARRAY[i];versions text[]:=ARRAY['1'];include_memory boolean:=true;
 head uuid;nodes jsonb;fresh_nodes jsonb;node jsonb;observation application_field_observations;
 memo jsonb:='{}';result jsonb;current_source jsonb;worklist_frame jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;
 memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN
 IF native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 IF actor IS NULL OR assistant IS NULL OR w IS NULL OR s IS NULL OR i IS NULL
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR current_setting('app.public_share_mode',true)='true'
  OR current_setting('app.agent_shared_audience',true)='true'
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class owned ON owned.oid='public.session_context_revision_contents'::regclass
   WHERE role.rolname=session_user AND(role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,owned.relowner,'USAGE')))
  OR NOT EXISTS(SELECT 1 FROM sessions parent WHERE parent.workspace_id=w AND parent.id=s
   AND parent.user_id=actor AND parent.assistant_id=assistant AND parent.visibility='personal'
   AND parent.channel_type='web' AND coalesce(parent.app_origin,'chat')='chat' AND parent.anchor_kind='none' AND parent.mode IS NULL)
 THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i
  AND r.session_id=s AND r.parent_kind='session_title' AND r.parent_id=s) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF jsonb_array_length(nodes) NOT BETWEEN 1 AND 4096
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='private_transcript')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory','private_transcript'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN private_transcript_observations o
   ON o.workspace_id=w AND o.id=(n->>'id')::uuid WHERE n->>'kind'='private_transcript'
    AND(o.id IS NULL OR o.user_id<>actor OR o.session_id<>s OR n->>'version'<>'1'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f
   ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field'
   AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
    OR f.type_key NOT IN('session_message','session_message_annotation','memory')
    OR f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')))
 THEN RETURN NULL;END IF;
 IF native_worklist_edges(w,nodes) IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='private_transcript'
  AND native_worklist_edges(w,nodes)->((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'))<>'[]'::jsonb) THEN RETURN NULL;END IF;
 -- Eligibility above is metadata only. Pin the workspace BEFORE any head,
 -- session or transcript lock, including the independent output invocation.
 -- Otherwise a concurrent publisher can hold workspace then wait for our head.
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RETURN '{"admitted":false}';END IF;
 IF session_recording_read_allowed(s) IS NOT TRUE OR recording_source_read_allowed(w,'session_context_revision',i) IS NOT TRUE
 THEN RETURN '{"admitted":false}';END IF;
 SELECT h.scope_revision_id INTO head FROM session_title_heads h WHERE h.workspace_id=w AND h.session_id=s FOR SHARE;
 IF head IS DISTINCT FROM i THEN RETURN '{"admitted":false}';END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,nodes)) THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;

 -- This private argument is created only by this closed SQL operation. It holds
 -- scope metadata, never a Memory business row or a shared selected-field grant.
 IF include_memory AND application_memory_statement_helpers_current() AND (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN
  BEGIN
   PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM id FROM memories WHERE workspace_id=w ORDER BY id FOR SHARE NOWAIT;
   IF NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_context:=application_memory_query_context(w);
   IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_rows:='{}';memory_cohort:='[]';
   FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
    IF memory_lineage IS DISTINCT FROM jsonb_build_array(jsonb_build_object('kind','memory','id',memory_candidate.id,'version',memory_candidate.scope_version::text)) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
    memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
    memory_rows:=memory_rows||jsonb_build_object(memory_candidate.id::text,jsonb_build_object('source',memory_source,'lineage',memory_lineage));
    memory_cohort:=memory_cohort||jsonb_build_array(jsonb_build_object('id',memory_candidate.id,'version',memory_candidate.scope_version::text));
   END LOOP;
   memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows',memory_rows,'cohort',memory_cohort));
  EXCEPTION WHEN lock_not_available THEN memory_rows:=NULL;memory_context:=NULL;memory_cohort:=NULL;
  END;
 END IF;

 -- A bounded current Memory lane is mandatory in this narrow profile. Anything
 -- else delegates to the unchanged complete validator, rather than a partial proof.
 IF memo#>>'{memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 worklist_frame:=native_private_title_frame(w,nodes);
 IF worklist_frame IS NULL THEN RETURN '{"admitted":false}';END IF;
 memo:=memo||jsonb_build_object('nativeWorklist',true);
 -- Private transcript nodes remain in the graph, never native allow memo keys.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes)
  WHERE value->>'kind' IN('session_message','session_context_revision','memory','private_transcript')
  ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='private_transcript' THEN
   current_source:=worklist_frame#>ARRAY['currents','private_transcript:'||(node->>'id'),'source'];
  ELSE
   IF node->>'kind'='session_context_revision' AND native_worklist_source(w,node->>'kind',(node->>'id')::uuid,worklist_frame) IS NULL
    THEN RETURN '{"admitted":false}';END IF;
   current_source:=native_detached_snapshot(w,node->>'kind',(node->>'id')::uuid,node->>'version',worklist_frame);
  END IF;
  IF current_source IS NULL THEN
   IF node->>'kind' IN('session_context_revision','private_transcript') THEN RETURN '{"admitted":false}';END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN '{"admitted":false}';END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind' IN('session_context_revision','private_transcript') THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN '{"admitted":false}';END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',dependency.user_id,
   'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,'compartments',dependency.compartments,
   'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN '{"admitted":false}';END IF;
 END LOOP;
 -- One operation-local memo through the unchanged evaluator, including every
 -- original field and its children. No speculative schedule/allow pre-priming.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field'
  ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=native_detached_eval_field(w,(node->>'id')::uuid,node->>'version',memo,worklist_frame);
  memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN '{"admitted":false}';END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',dependency.user_id,
   'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,'compartments',dependency.compartments,
   'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN '{"admitted":false}';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO fresh_nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF nodes IS DISTINCT FROM fresh_nodes THEN RETURN '{"admitted":false}';END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,nodes)) THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;

 IF memo ? 'memoryStatement' THEN
  IF application_memory_statement_helpers_current() IS NOT TRUE OR application_memory_query_context(w) IS DISTINCT FROM memory_context OR NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',scope_version::text) ORDER BY id),'[]') INTO memory_cohort FROM memories WHERE workspace_id=w;
  IF memory_cohort IS DISTINCT FROM memo#>'{memoryStatement,cohort}' THEN RETURN NULL;END IF;
  FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
   memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
   IF memory_source IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'source'] OR memory_lineage IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'lineage'] THEN RETURN NULL;END IF;
  END LOOP;
 END IF;

 IF application_memory_statement_helpers_current() IS NOT TRUE
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
   WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
   IS DISTINCT FROM '2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376' THEN RETURN NULL;END IF;
 -- Independently reconstruct every current snapshot, private manifest, context
 -- and exact edge set from identities. Old frame-current's seed is deliberately
 -- closed to private leaves; use its complete additive counterpart, not a filter.
 IF native_private_title_frame(w,nodes) IS DISTINCT FROM worklist_frame THEN RETURN '{"admitted":false}';END IF;
 -- Also retain the independent canonical source reader: consistency between
 -- optimized frames must never substitute for ordinary current admission.
 FOR node IN SELECT value FROM jsonb_each(worklist_frame->'currents') LOOP
  current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
  IF to_jsonb(current_source) IS DISTINCT FROM
   (CASE WHEN node->'source'='null'::jsonb THEN NULL ELSE node->'source' END)
  THEN RETURN '{"admitted":false}';END IF;
 END LOOP;
 IF native_worklist_edges(w,nodes) IS DISTINCT FROM worklist_frame->'edges'
  OR native_worklist_context(w,nodes) IS DISTINCT FROM worklist_frame->'context'
  OR native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT h.scope_revision_id INTO head FROM session_title_heads h WHERE h.workspace_id=w AND h.session_id=s FOR SHARE;
 IF head IS DISTINCT FROM i OR session_recording_read_allowed(s) IS NOT TRUE
  OR recording_source_read_allowed(w,'session_context_revision',i) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM sessions parent WHERE parent.workspace_id=w AND parent.id=s AND parent.user_id=actor
   AND parent.assistant_id=assistant AND parent.visibility='personal' AND parent.channel_type='web'
   AND coalesce(parent.app_origin,'chat')='chat' AND parent.anchor_kind='none' AND parent.mode IS NULL)
 THEN RETURN '{"admitted":false}';END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
EXCEPTION WHEN data_exception OR insufficient_privilege OR no_data_found THEN RETURN NULL;
 WHEN raise_exception THEN
  IF SQLERRM IN('scope_source_changed','scope_evidence_missing','scope_operation_denied','access_unavailable','scope_ancestry_unavailable') THEN RETURN NULL;END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION native_private_title_proof(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION read_native_private_title_evidence(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s uuid;proof jsonb;
BEGIN
 IF (SELECT false /*__GUARD_CURRENT__*/) IS NOT TRUE THEN RETURN NULL;END IF;
 IF native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT r.session_id INTO s FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i;
 proof:=native_private_title_proof(w,s,i);
 IF (SELECT false /*__GUARD_CURRENT__*/) IS NOT TRUE THEN RETURN NULL;END IF;
 IF native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION read_native_private_title_evidence(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_native_private_title_acquisition(w uuid,s uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE proof jsonb;payload jsonb;
BEGIN
 IF (SELECT false /*__GUARD_CURRENT__*/) IS NOT TRUE THEN RETURN NULL;END IF;
 IF native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 proof:=native_private_title_proof(w,s,i);
 IF proof IS NULL THEN RETURN NULL;END IF;
 IF proof->>'admitted' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('title',NULL,'proof',proof);END IF;
 SELECT c.content INTO payload FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i;
 IF payload IS NULL THEN RETURN NULL;END IF;
 IF (SELECT false /*__GUARD_CURRENT__*/) IS NOT TRUE THEN RETURN NULL;END IF;
 IF native_private_title_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('title',jsonb_build_object('sessionId',s,'revisionId',i,'content',payload),'proof',proof);
END $$;
REVOKE ALL ON FUNCTION read_native_private_title_acquisition(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_private_title_evidence(uuid,uuid),read_native_private_title_acquisition(uuid,uuid,uuid) TO app_user;
END IF;END $$;

-- Full pg_proc metadata includes owner, ACL, language, volatility, search_path,
-- return/argument shape and body. Authenticate existing guards too: replacing
-- one with RETURN true must never manufacture a new complete-proof permission.
DO $pins$
DECLARE signatures text[]:=ARRAY[
 'native_private_title_frame(uuid,jsonb)','native_private_title_proof(uuid,uuid,uuid)',
 'application_native_worklist_helpers_current()','application_memory_statement_helpers_current()',
 'application_empty_query_helpers_current()',
 'read_private_transcript_source(uuid,uuid)','private_transcript_message_fingerprint(session_messages)',
 'private_legacy_history_binding(sessions)','read_entity_derivation_source(uuid,text,uuid)',
 'read_scope_source(uuid,text,uuid)','scope_source_ancestors(uuid,text,uuid)',
 'read_admitted_native_scope_snapshot(uuid,text,uuid)',
 'read_native_session_query_cohort_nodes(uuid,jsonb)',
 'read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])',
 'read_external_source_dependencies(uuid,text[],uuid[],text[])',
 'read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)',
 'application_session_eval_scope_current(uuid,text,uuid,text,jsonb)',
 'read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'];
 pins text;body text;signature text;guard_fingerprint text;guard_check text;
BEGIN
 IF array_position(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(signatures) s),NULL) IS NOT NULL
 THEN RAISE EXCEPTION 'private_title_dependency_missing';END IF;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(signatures) s));
 body:='BEGIN IF (SELECT count(*)='||cardinality(signatures)||' AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false) FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF; RETURN application_native_worklist_helpers_current() AND application_memory_statement_helpers_current(); END';
 EXECUTE replace(pg_get_functiondef('native_private_title_helpers_current()'::regprocedure),(SELECT prosrc FROM pg_proc WHERE oid='native_private_title_helpers_current()'::regprocedure),body);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_fingerprint FROM pg_proc p WHERE p.oid='native_private_title_helpers_current()'::regprocedure;
 guard_check:=format('(SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=%L FROM pg_catalog.pg_proc p WHERE p.oid=''public.native_private_title_helpers_current()''::regprocedure)',guard_fingerprint);
 FOREACH signature IN ARRAY ARRAY['read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)'] LOOP
  EXECUTE replace(pg_get_functiondef(to_regprocedure('public.'||signature)),'(SELECT false /*__GUARD_CURRENT__*/)',guard_check);
 END LOOP;
END $pins$;
COMMIT;
