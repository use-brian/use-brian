BEGIN;
-- [COMP:api/application-persistence] Fresh closed-cohort validation; no permission cache.
CREATE FUNCTION read_native_session_query_cohort_nodes(w uuid,nodes jsonb)
RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item record;selector record;message record;specs jsonb:='[]';root jsonb;kind text;id uuid;attempts integer:=0;
 candidates jsonb;part record;has_external boolean:=false;
BEGIN
 IF jsonb_typeof(nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(nodes)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR item IN SELECT DISTINCT q.type_key,q.domain FROM jsonb_to_recordset(nodes) node(kind text,id uuid,version text)
  JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=node.id AND node.kind='application_field'
  JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=resource.id AND observation.version=node.version
  JOIN application_query_domains q ON q.workspace_id=w AND q.id=resource.resource_id AND q.origin=resource.origin AND q.type_key=resource.type_key
  WHERE resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key IN('session_message','session_message_annotation')
   AND resource.selection='query_domain' LOOP
  IF item.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1' OR application_query_scope_valid(item.domain->'bounds') IS NOT TRUE
   OR jsonb_typeof(item.domain->'visibility') IS DISTINCT FROM 'object' OR jsonb_typeof(item.domain->'throughSequence') IS DISTINCT FROM 'number'
   OR (item.domain->>'throughSequence')::integer<0 OR item.domain->>'sessionId' IS NULL THEN
   RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
  specs:=specs||jsonb_build_array(jsonb_build_object('type',item.type_key,'sessionId',item.domain->'sessionId',
   'bounds',item.domain->'bounds','visibility',item.domain->'visibility','through',item.domain->'throughSequence'));
 END LOOP;
 -- A complete fresh physical-cohort superset can prove there are no
 -- independent-source references before expensive native scope snapshots.
 -- This grants no local rights and does not reuse an envelope or permission.
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',n.kind,'id',n.id,'version',n.version)),'[]') INTO candidates FROM (
  SELECT DISTINCT CASE WHEN spec.value->>'type'='session_message' THEN 'session_message' ELSE 'session_context_revision' END AS kind,
   CASE WHEN spec.value->>'type'='session_message' THEN m.id ELSE h.scope_revision_id END AS id,
   CASE WHEN spec.value->>'type'='session_message' THEN m.scope_version::text ELSE '1' END AS version
  FROM jsonb_array_elements(specs) spec(value)
  JOIN session_messages m ON m.workspace_id=w AND m.session_id=(spec.value->>'sessionId')::uuid AND m.sequence_num<=(spec.value->>'through')::integer
  LEFT JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
  WHERE spec.value->>'type'='session_message' OR h.scope_revision_id IS NOT NULL
  LIMIT 4097
 ) n;
 IF jsonb_array_length(candidates)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 FOR part IN SELECT array_agg(node->>'kind') AS kinds,array_agg((node->>'id')::uuid) AS ids,array_agg(node->>'version') AS versions
  FROM jsonb_array_elements(candidates) WITH ORDINALITY candidate(node,ord) GROUP BY (ord-1)/100 LOOP
  IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,part.kinds,part.ids,part.versions)) THEN has_external:=true;EXIT;END IF;
 END LOOP;
 IF NOT has_external THEN RETURN;END IF;
 -- Equal scope/visibility prefixes have an exact union at their maximum
 -- sequence. Field values never participate in this metadata normalization.
 FOR selector IN SELECT value->>'type' AS type_key,(value->>'sessionId')::uuid AS session_id,
  value->'bounds' AS bounds,value->'visibility' AS visibility,max((value->>'through')::integer) AS through_sequence
  FROM jsonb_array_elements(specs) GROUP BY value->>'type',value->>'sessionId',value->'bounds',value->'visibility' LOOP
  FOR message IN SELECT m.id,m.scope_version,h.scope_revision_id FROM session_messages m
   LEFT JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
   WHERE m.workspace_id=w AND m.session_id=selector.session_id AND m.sequence_num<=selector.through_sequence ORDER BY m.sequence_num,m.id LOOP
   IF selector.type_key='session_message' THEN kind:='session_message';id:=message.id;
   ELSE kind:='session_context_revision';id:=message.scope_revision_id;IF id IS NULL THEN CONTINUE;END IF;END IF;
   root:=read_scope_source(w,kind,id);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN CONTINUE;END IF;
   IF application_query_scope_admits_point(selector.bounds,root) IS NOT TRUE
    OR root->>'userId' IS NOT NULL AND root->>'userId' IS DISTINCT FROM selector.visibility->>'userId'
    OR root->>'assistantId' IS NOT NULL AND selector.visibility->'assistants'<>'null'::jsonb
     AND NOT coalesce(selector.visibility->'assistants' ? (root->>'assistantId'),false) THEN CONTINUE;END IF;
   attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',root->'userId','assistantId',root->'assistantId',
    'sensitivity',root->'sensitivity','compartments',root->'compartments','projectIds',root->'projectIds',
    'resourceKind',kind,'resourceId',id,'version',root->'version');RETURN NEXT;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_session_query_cohort_nodes(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION read_native_session_cohort_evidence(w uuid,kinds text[],ids uuid[],versions text[],include_memory boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- A changed original evaluator retains its full original fallback contract.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,nodes)) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
   RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 -- Every original derivation envelope still applies, including those on
 -- native ancestors. The full closure contains no raw Entity source; any such
 -- source already delegated above to the unchanged original evaluator.
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN
   RETURN jsonb_build_object('admitted',false);END IF;
 END LOOP;
 -- The evaluator contract is also current at return.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO fresh_nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF nodes IS DISTINCT FROM fresh_nodes THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;

 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,fresh_nodes)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END $$;
REVOKE ALL ON FUNCTION read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean) FROM PUBLIC;
ALTER FUNCTION read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean) SET plan_cache_mode=force_generic_plan;
CREATE OR REPLACE FUNCTION read_native_session_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';cohort jsonb;
BEGIN
 cohort:=read_native_session_cohort_evidence(w,kinds,ids,versions,false);
 IF cohort IS NOT NULL THEN RETURN cohort;END IF;

 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message')) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  result:=application_session_eval_scope_current(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=nullif(result->'current','null'::jsonb);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 IF nodes IS DISTINCT FROM(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') FROM application_scope_lineage(w,kinds,ids,versions) n) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);

END $$;
REVOKE ALL ON FUNCTION read_native_session_evidence(uuid,text[],uuid[],text[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION read_native_attended_memory_evidence(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';cohort jsonb;
BEGIN
 cohort:=read_native_session_cohort_evidence(w,kinds,ids,versions,true);
 IF cohort IS NOT NULL THEN RETURN cohort;END IF;

 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR field.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN NULL;END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  result:=application_session_eval_scope_current(w,node->>'kind',(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);
  IF result->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=nullif(result->'current','null'::jsonb);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 IF nodes IS DISTINCT FROM(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') FROM application_scope_lineage(w,kinds,ids,versions) n) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_sources(w,kinds,ids,versions)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);

END $$;
REVOKE ALL ON FUNCTION read_native_attended_memory_evidence(uuid,text[],uuid[],text[]) FROM PUBLIC;
CREATE FUNCTION capture_native_session_projection_batch(w uuid,s uuid,through integer,t text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;scanned jsonb;fields text[];domain jsonb;identity_value text;domain_id uuid;
 frozen application_query_domains;envelope jsonb;child jsonb;source jsonb;external jsonb;result jsonb;memo jsonb:='{}';
 ids uuid[];versions text[];snap record;expected jsonb;captures jsonb;rows_json jsonb:='[]';position integer:=0;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) IS DISTINCT FROM '8f7f28732bfddafd57fea2e215075ae8d75ba9097433536800a74bc99f2b6860'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_current_field_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_materialize_field_envelope(uuid,jsonb,integer)'::regprocedure) IS DISTINCT FROM '6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure) IS DISTINCT FROM '670666fe20bf2fcce959f7f12e43dbddcf35d1c9edceec63d59d1626a07087b4'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure) IS DISTINCT FROM '50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7' THEN RETURN NULL;END IF;
 IF actor IS NULL OR t NOT IN('session_message','session_message_annotation') OR through IS NULL OR through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
 IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(t)) field ORDER BY field);
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 result:=application_session_eval_scan(w,s,t,through,fields,bounds,visibility,memo);memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','session_query_domain_v1','sessionId',s,'throughSequence',through,'fields',fields,'bounds',bounds,'visibility',visibility,
  'parentFingerprint',parent->'fingerprint','candidates',scanned->'candidates','points',scanned->'points');
 identity_value:=application_field_digest(jsonb_build_object('kind','session_query_domain_v1','workspaceId',w,'type',t,'domain',domain));
 domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}',t,'1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR (frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM (t,'1',domain,identity_value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 result:=application_session_eval_envelope(w,t,domain_id,'query_domain',fields,memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope#>>'{state,recordVersion}' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(envelope->'sources') WHERE value->>'resourceKind'='external_source' LOOP
  external:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  IF external IS NULL OR external->>'held' IS DISTINCT FROM 'false' OR external->>'version' IS DISTINCT FROM source->>'version'
   OR NOT EXISTS(SELECT 1 FROM external_source_observations observation WHERE observation.workspace_id=w AND observation.id=(source->>'resourceId')::uuid
    AND observation.observation#>>'{retention,mode}'='governed') THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF application_field_envelope_ancestry_allowed(w,envelope) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 PERFORM application_materialize_field_envelope(w,envelope);
 captures:=jsonb_build_array(envelope)||coalesce(envelope->'children','[]');
 SELECT array_agg((value->>'resourceId')::uuid ORDER BY ord),array_agg(value#>>'{source,version}' ORDER BY ord) INTO ids,versions
  FROM jsonb_array_elements(captures) WITH ORDINALITY capture(value,ord);
 -- This new call owns a fresh private worklist. No initial admission is reused.
 FOR snap IN SELECT * FROM read_native_session_field_snapshots(w,ids,versions) ORDER BY ord LOOP
  position:=position+1;expected:=captures->(position-1);
  IF snap.ord IS DISTINCT FROM position OR snap.snapshot IS NULL OR snap.snapshot->>'held' IS DISTINCT FROM 'false'
   OR snap.snapshot->>'version' IS DISTINCT FROM expected#>>'{source,version}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF position<>jsonb_array_length(captures) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) IS DISTINCT FROM '8f7f28732bfddafd57fea2e215075ae8d75ba9097433536800a74bc99f2b6860'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_current_field_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_materialize_field_envelope(uuid,jsonb,integer)'::regprocedure) IS DISTINCT FROM '6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure) IS DISTINCT FROM '670666fe20bf2fcce959f7f12e43dbddcf35d1c9edceec63d59d1626a07087b4'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure) IS DISTINCT FROM '50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 rows_json:=jsonb_build_array(jsonb_build_object('row',NULL,'sources',jsonb_build_array(envelope->'source')||(envelope->'sources')));
 FOR child IN SELECT value FROM jsonb_array_elements(coalesce(envelope->'children','[]')) LOOP
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('row',child#>'{state,values}','sources',jsonb_build_array(child->'source')||(child->'sources')));
 END LOOP;
 RETURN rows_json;
END $$;
REVOKE ALL ON FUNCTION capture_native_session_projection_batch(uuid,uuid,integer,text) FROM PUBLIC;
ALTER FUNCTION capture_native_session_projection_batch(uuid,uuid,integer,text) SET plan_cache_mode=force_generic_plan;
CREATE OR REPLACE FUNCTION read_native_application_session_projection(w uuid,s uuid,through integer,t text) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;scanned jsonb;fields text[];domain jsonb;identity_value text;domain_id uuid;
 frozen application_query_domains;batch jsonb;captured jsonb;point jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 batch:=capture_native_session_projection_batch(w,s,through,t);
 IF batch IS NOT NULL THEN RETURN QUERY SELECT item FROM jsonb_array_elements(batch) item;RETURN;END IF;
 IF actor IS NULL OR t NOT IN('session_message','session_message_annotation') OR through IS NULL OR through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
 IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(t)) field ORDER BY field);
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 scanned:=application_session_query_scan(w,s,t,through,fields,bounds,visibility);
 IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','session_query_domain_v1','sessionId',s,'throughSequence',through,'fields',fields,'bounds',bounds,'visibility',visibility,
  'parentFingerprint',parent->'fingerprint','candidates',scanned->'candidates','points',scanned->'points');
 identity_value:=application_field_digest(jsonb_build_object('kind','session_query_domain_v1','workspaceId',w,'type',t,'domain',domain));
 domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}',t,'1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR (frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM (t,'1',domain,identity_value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}',t,domain_id,'1','query_domain',NULL,fields);
 IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 value:=jsonb_build_object('row',NULL,'sources',captured->'sources');RETURN NEXT;
 FOR point IN SELECT item FROM jsonb_array_elements(scanned->'points') item LOOP
  captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}',t,(point->>'id')::uuid,point->>'version','query',NULL,fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  value:=jsonb_build_object('row',captured->'values','sources',captured->'sources');RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_session_projection(uuid,uuid,integer,text) FROM PUBLIC;
-- Execution plans only; retain every original deferred row/source check.
ALTER FUNCTION publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb) SET plan_cache_mode=force_generic_plan;
ALTER FUNCTION validate_application_field_dependencies() SET plan_cache_mode=force_generic_plan;
COMMIT;
