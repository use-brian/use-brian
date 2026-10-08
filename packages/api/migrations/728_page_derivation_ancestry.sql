BEGIN;
-- [COMP:api/workflow-input-evidence] Metadata only; callers must admit it.
CREATE FUNCTION page_scope_source_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt workflow_page_event_receipts; observation workflow_page_event_observations; causal_role text;
BEGIN
 IF k NOT IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN RETURN NULL; END IF;
 causal_role:=CASE WHEN k LIKE '%_destination' THEN 'destination' ELSE 'changed' END;
 IF k LIKE 'page_live_%' THEN
  SELECT * INTO observation FROM workflow_page_event_observations WHERE workspace_id=w AND id=i AND workflow_page_event_observations.role=causal_role FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN page_event_scope_descriptor(i,causal_role,observation.boundary,true);
 END IF;
 SELECT * INTO receipt FROM workflow_page_event_receipts WHERE workspace_id=w AND revision=i FOR SHARE;
 IF NOT FOUND OR (causal_role='destination' AND receipt.metadata->>'action' NOT IN ('created','moved')) THEN RETURN NULL; END IF;
 RETURN page_event_scope_descriptor(i,causal_role,receipt.boundaries->causal_role,false);
END $$;
REVOKE ALL ON FUNCTION page_scope_source_snapshot(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION read_resource_page_dependencies(w uuid,k text,i uuid,v text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE node record; item jsonb; supplied jsonb; snapshot jsonb; result jsonb:='[]'; candidates jsonb;
BEGIN
 FOR node IN WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT k,i,v
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id,s.source_version AS version
    FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
    WHERE d.workspace_id=w AND d.resource_kind=l.kind AND d.resource_id=l.id
   UNION
   SELECT 'workspace_file',wf.id,wf.scope_version::text FROM file_segments fs
    JOIN workspace_files wf ON wf.id=fs.file_id AND wf.workspace_id=fs.workspace_id
    WHERE l.kind='file_segment' AND fs.workspace_id=w AND fs.id=l.id
  ) next
 ) SELECT * FROM lineage LOOP
  candidates:='[]';
  IF node.kind IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
   candidates:=jsonb_build_array(jsonb_build_object('resourceKind',node.kind,'resourceId',node.id,'version',node.version));
  ELSIF node.kind='workflow_run' THEN
   PERFORM read_scope_source(w,node.kind,node.id);
   IF NOT EXISTS(SELECT 1 FROM workflow_runs WHERE workspace_id=w AND id=node.id) THEN RAISE EXCEPTION 'page_ancestry_unavailable'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(read_workflow_derivation_inputs(w,node.id)) LOOP
    candidates:=candidates||coalesce(item#>'{evidence,sources}','[]');
   END LOOP;
  END IF;
  FOR supplied IN SELECT value FROM jsonb_array_elements(candidates)
   WHERE value->>'resourceKind' IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination') LOOP
   snapshot:=page_scope_source_snapshot(w,supplied->>'resourceKind',(supplied->>'resourceId')::uuid);
   IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM supplied->>'version' THEN RAISE EXCEPTION 'page_ancestry_unavailable'; END IF;
   result:=result||jsonb_build_array(snapshot);
  END LOOP;
 END LOOP;
 RETURN (SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(result));
END $$;
REVOKE ALL ON FUNCTION read_resource_page_dependencies(uuid,text,uuid,text) FROM PUBLIC;
COMMIT;
