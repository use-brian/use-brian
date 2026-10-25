BEGIN;
-- [COMP:api/application-persistence] Current native Memory fields use the existing closed-cohort validator.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure)
  IS DISTINCT FROM '7f1d72aef033c472275b36defe55017aff945b71b3298fb11bcc8130ca6e755a' THEN RAISE EXCEPTION 'Native cohort prerequisite changed';END IF;
END $$;
CREATE OR REPLACE FUNCTION read_native_session_cohort_evidence(w uuid,kinds text[],ids uuid[],versions text[],include_memory boolean) RETURNS jsonb
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
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;
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

 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END $$;
COMMIT;
