BEGIN;
-- [COMP:api/external-source-access] Content-free ancestry, never source authorization.
CREATE FUNCTION read_external_source_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(kinds,NULL) IS NOT NULL
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
WITH RECURSIVE lineage(kind,id,version) AS (
      SELECT * FROM unnest($2::text[],$3::uuid[],$4::text[])
      UNION
      SELECT next.kind,next.id,next.version FROM lineage l CROSS JOIN LATERAL (
        SELECT s.source_kind AS kind,s.source_id AS id,s.source_version AS version FROM scope_derivations d
          JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
          WHERE d.workspace_id=$1 AND d.resource_kind=l.kind AND d.resource_id=l.id
        UNION
        SELECT l.kind,prior_id,l.version FROM unnest(CASE WHEN scope_source_table(l.kind) IS NOT NULL
          THEN ARRAY(SELECT resource_id FROM scope_source_ancestors($1,l.kind,l.id)) ELSE '{}'::uuid[] END) prior_id
          WHERE prior_id<>l.id
        UNION
        SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
          JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
          WHERE l.kind='file_segment' AND fs.workspace_id=$1 AND fs.id=l.id
        UNION
        SELECT observed.value->>'resourceKind',(observed.value->>'resourceId')::uuid,observed.value->>'version'
          FROM jsonb_array_elements(CASE WHEN l.kind='workflow_run' THEN read_workflow_derivation_inputs($1,l.id) ELSE '[]'::jsonb END) input
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(input#>'{evidence,sources}','[]'::jsonb)
            || CASE WHEN jsonb_typeof(input->'blueprintSource')='object' THEN jsonb_build_array(input->'blueprintSource') ELSE '[]'::jsonb END) observed(value)
      ) next
    ), bounded AS MATERIALIZED (SELECT * FROM lineage LIMIT 4097)
      SELECT l.version AS "nodeVersion",CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
      'workspaceId',o.workspace_id,'userId',NULL,'assistantId',NULL,'resourceKind','external_source','resourceId',o.id,'version',o.version,
      'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids) END AS source
      FROM bounded l LEFT JOIN external_source_observations o ON o.workspace_id=$1 AND o.id=l.id
      WHERE l.kind='external_source'
      UNION ALL SELECT NULL,NULL WHERE (SELECT count(*) FROM bounded)>4096;
END $$;
REVOKE ALL ON FUNCTION read_external_source_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION read_admitted_external_source_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 dependencies jsonb; root jsonb; n integer;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
    OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('nodeVersion',d.node_version,'source',d.source)),'[]') INTO dependencies
  FROM read_external_source_dependencies(w,kinds,ids,versions) d;
 -- Empty dependencies reveal nothing; ordinary native D1 lifecycle remains unchanged.
 IF jsonb_array_length(dependencies)>0 THEN
  FOR n IN 1..cardinality(ids) LOOP
   root:=read_entity_derivation_source(w,kinds[n],ids[n]);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';
   END IF;
  END LOOP;
 END IF;
 RETURN QUERY SELECT value->>'nodeVersion',value->'source' FROM jsonb_array_elements(dependencies);
END $$;
REVOKE ALL ON FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
