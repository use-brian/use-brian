BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

DO $knowledge_dependency_verifier$
BEGIN
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid='public.read_admitted_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '91fcb4c94363c6717d48bd3b724ddf74f7447f1837b152a111dcd18694b72a56'
 THEN RAISE EXCEPTION 'knowledge_field_proof_predecessor_changed'; END IF;
END $knowledge_dependency_verifier$;

-- [COMP:api/application-persistence] Reproduce exact ordinary Knowledge field
-- observation proofs without reading values or repeating the shared context.
CREATE FUNCTION public.application_knowledge_exact_field_proofs(w uuid,ids uuid[],versions text[])
RETURNS TABLE(resource_id uuid, observation_version text, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 native_origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
 search_fields constant text[]:=ARRAY['content','id','path','sourceId','summary','tags','title'];
 actor_context jsonb;
BEGIN
 IF ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096
  OR cardinality(ids)<>cardinality(versions) THEN RETURN; END IF;
 -- This is an optional evaluator for current native membership and the built-in catalog.
 IF NOT EXISTS (
  SELECT 1 FROM unnest(ids,versions) input(id,version)
  JOIN application_field_resources r ON r.workspace_id=w AND r.id=input.id
  WHERE r.origin=native_origin AND r.type_key='knowledge_entry' AND r.selection='query' AND r.fields=search_fields
 ) THEN RETURN; END IF;
 actor_context:=application_knowledge_query_context(w);
 IF actor_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true'
  OR NOT coalesce(to_jsonb(search_fields)<@(actor_context->'read'),false)
  OR EXISTS (SELECT 1 FROM application_native_resource_owners o
    WHERE o.workspace_id=w AND o.origin=native_origin AND o.resource_type='knowledge_entry')
 THEN RETURN; END IF;

 RETURN QUERY
 WITH observations AS MATERIALIZED (
  SELECT DISTINCT r.id AS field_id, r.resource_id AS entry_id, r.identity, r.field_identity,
   o.version, o.source_version, o.policy_version, o.source_scope
  FROM unnest(ids,versions) input(id,version)
  JOIN application_field_resources r ON r.workspace_id=w AND r.id=input.id
  JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=r.id AND o.version=input.version
  JOIN knowledge_entries k ON k.workspace_id=w AND k.id=r.resource_id
  WHERE r.origin=native_origin AND r.type_key='knowledge_entry' AND r.selection='query'
   AND r.selected_version IS NULL AND r.fields=search_fields AND o.owner_id IS NULL
   AND o.source_kind='knowledge_entry' AND o.source_id=k.id
   AND o.record_version=k.scope_version::text AND o.source_version=o.record_version
   AND NOT scope_review_state_held('application_field',r.id)
   AND NOT EXISTS (SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w
    AND ((d.resource_kind='knowledge_entry' AND d.resource_id=k.id)
      OR (d.resource_kind='application_field' AND d.resource_id=r.id)))
   AND NOT EXISTS (SELECT 1 FROM knowledge_entry_revision_publications p WHERE p.workspace_id=w AND p.entry_id=k.id)
   AND NOT EXISTS (SELECT 1 FROM application_field_observation_sources s
    WHERE s.workspace_id=w AND s.resource_id=r.id AND s.version=o.version)
 ), points AS MATERIALIZED (
  SELECT roots.entry_id,application_knowledge_admitted_fields(w,roots.entry_id,search_fields,actor_context,false) AS current_state
  FROM (SELECT DISTINCT o.entry_id FROM observations o ORDER BY o.entry_id) roots
 ), compared AS MATERIALIZED (
  SELECT o.*,p.current_state,
   (p.current_state->'source')-ARRAY['resourceKind','resourceId','version'] AS current_scope,
   application_field_digest(jsonb_build_object('workspaceId',w,'origin',native_origin,'typeKey','knowledge_entry',
    'id',o.entry_id,'selection','query','selectedVersion',NULL,'fields',search_fields,
    'fieldIdentity',p.current_state->'fieldIdentity')) AS current_identity
  FROM observations o JOIN points p USING(entry_id)
  WHERE p.current_state IS NOT NULL
 )
 SELECT c.field_id,c.version,c.current_scope||jsonb_build_object(
  'resourceKind','application_field','resourceId',c.field_id,'version',c.version,
  'held',false,'validTo',NULL,'retractedAt',NULL)
 FROM compared c
 WHERE c.current_identity=c.identity AND application_field_resource_uuid(c.identity)=c.field_id
  AND c.current_state->>'fieldIdentity'=c.field_identity
  AND c.current_state->>'policyVersion'=c.policy_version
  AND c.current_state->>'recordVersion'=c.source_version
  AND c.current_scope=c.source_scope
  AND entity_derivation_envelope_valid(c.current_scope) IS TRUE
  AND application_reader_envelope_visible(w,c.current_scope) IS TRUE
  AND application_field_digest(jsonb_build_object('resourceId',c.field_id,
   'recordVersion',c.current_state->>'recordVersion','sourceVersion',c.current_state->>'sourceVersion',
   'policyVersion',c.current_state->'policyVersion','scope',c.current_scope,'sources','[]'::jsonb))=c.version;
END $$;
REVOKE ALL ON FUNCTION public.application_knowledge_exact_field_proofs(uuid,uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION public.application_knowledge_exact_field_proofs(uuid,uuid[],text[]) FROM app_user;
END IF; END $$;

CREATE OR REPLACE FUNCTION public.read_admitted_application_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE dependency record;
BEGIN
 FOR dependency IN
  WITH dependencies AS MATERIALIZED (
   SELECT d.node_version AS version,d.source AS original,(d.source->>'resourceId')::uuid AS id,d.position
   FROM read_application_field_dependencies(w,kinds,ids,versions) WITH ORDINALITY d(node_version,source,position)
  ), exact AS MATERIALIZED (
   SELECT proof.* FROM application_knowledge_exact_field_proofs(w,
    ARRAY(SELECT d.id FROM dependencies d ORDER BY d.position),
    ARRAY(SELECT d.version FROM dependencies d ORDER BY d.position)) proof
  )
  SELECT d.version,d.original,coalesce(e.snapshot,read_admitted_application_field_snapshot(w,d.id,d.version)) AS admitted
  FROM dependencies d LEFT JOIN exact e ON e.resource_id=d.id AND e.observation_version=d.version
  ORDER BY d.position
 LOOP
  IF dependency.admitted IS NULL OR dependency.admitted->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
  node_version:=dependency.version;
  source:=dependency.original;
  RETURN NEXT;
 END LOOP;
END $$;

CREATE FUNCTION public.read_admitted_application_field_snapshots(w uuid,ids uuid[],versions text[])
RETURNS TABLE(ord integer,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Keep the original native facade's input validation and mixed-family epoch fence.
 IF ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096
  OR cardinality(ids)<>cardinality(versions)
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL
  OR array_ndims(ids)<>1 OR array_lower(ids,1)<>1 OR array_ndims(versions)<>1 OR array_lower(versions,1)<>1
  OR EXISTS (
   SELECT 1 FROM unnest(ids) input(id)
   LEFT JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=input.id
   WHERE resource.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR resource.type_key IS DISTINCT FROM 'knowledge_entry'
  )
 THEN
  RETURN QUERY SELECT result.ord,result.snapshot FROM read_native_session_field_snapshots(w,ids,versions) result;
  RETURN;
 END IF;

 RETURN QUERY
 WITH inputs AS MATERIALIZED (
  SELECT input.id,input.version,input.position::integer
  FROM unnest(ids,versions) WITH ORDINALITY input(id,version,position)
 ), exact AS MATERIALIZED (
  SELECT proof.resource_id,proof.observation_version,proof.snapshot
  FROM application_knowledge_exact_field_proofs(w,ids,versions) proof
 ), admitted AS MATERIALIZED (
  SELECT i.*,e.snapshot
  FROM inputs i LEFT JOIN exact e ON e.resource_id=i.id AND e.observation_version=i.version
 ), residual AS MATERIALIZED (
  SELECT a.*,row_number() OVER(ORDER BY a.position) AS residual_position
  FROM admitted a WHERE a.snapshot IS NULL
 ), parameters AS (
  SELECT array_agg(r.id ORDER BY r.position) AS residual_ids,
   array_agg(r.version ORDER BY r.position) AS residual_versions
  FROM residual r HAVING count(*)>0
 ), delegated AS MATERIALIZED (
  SELECT result.ord,result.snapshot
  FROM parameters p CROSS JOIN LATERAL read_native_session_field_snapshots(w,p.residual_ids,p.residual_versions) result
 )
 SELECT a.position,a.snapshot FROM admitted a WHERE a.snapshot IS NOT NULL
 UNION ALL
 SELECT r.position,d.snapshot FROM residual r JOIN delegated d ON d.ord=r.residual_position
 ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION public.read_admitted_application_field_snapshots(uuid,uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION public.read_admitted_application_field_snapshots(uuid,uuid[],text[]) TO app_user;
END IF; END $$;

-- The bounded reader shares the original SQL authority and frozen domain.
-- Only the per-point observation loop reads a slice.
DO $knowledge_point_page$
DECLARE
 predecessor constant regprocedure:='public.read_native_knowledge_query_projection(uuid,text[],boolean,uuid)'::regprocedure;
 signature constant text:='CREATE OR REPLACE FUNCTION public.read_native_knowledge_query_projection(w uuid, fields text[], include_retained boolean, deny_assistant uuid)';
 validation constant text:=$search$BEGIN
 IF fields IS NULL$search$;
 points constant text:=$search$FOR point IN SELECT item FROM jsonb_array_elements(scanned->'candidates') item LOOP$search$;
 definition text;
BEGIN
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid=predecessor AND p.prosecdef AND p.proowner=current_user::regrole::oid)
  IS DISTINCT FROM '1ba231950edc93b431a964dcd325de4ab0156affc3e614714dfe872cba11c6ea'
 THEN RAISE EXCEPTION 'knowledge_point_page_predecessor_changed'; END IF;
 definition:=pg_get_functiondef(predecessor);
 IF array_length(string_to_array(definition,signature),1)<>2
  OR array_length(string_to_array(definition,validation),1)<>2
  OR array_length(string_to_array(definition,points),1)<>2
 THEN RAISE EXCEPTION 'knowledge_point_page_source_changed'; END IF;
 definition:=replace(definition,signature,
  'CREATE FUNCTION public.read_native_knowledge_query_projection(w uuid, fields text[], include_retained boolean, deny_assistant uuid, point_offset integer, point_limit integer)');
 definition:=replace(definition,validation,$search$BEGIN
 IF point_offset IS NULL OR point_offset NOT BETWEEN 0 AND 4096
  OR point_limit IS NULL OR point_limit NOT BETWEEN 1 AND 512
 THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 IF fields IS NULL$search$);
 definition:=replace(definition,points,$search$FOR point IN
  SELECT projected.item FROM jsonb_array_elements(scanned->'candidates') WITH ORDINALITY projected(item,position)
  ORDER BY projected.position LIMIT point_limit OFFSET point_offset
 LOOP$search$);
 EXECUTE definition;
END $knowledge_point_page$;
REVOKE ALL ON FUNCTION public.read_native_knowledge_query_projection(uuid,text[],boolean,uuid,integer,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION public.read_native_knowledge_query_projection(uuid,text[],boolean,uuid,integer,integer) TO app_user;
END IF; END $$;

COMMIT;
