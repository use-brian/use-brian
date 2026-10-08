BEGIN;
-- [COMP:api/workflow-authority] App transactions validate only captured readable inputs.
CREATE FUNCTION read_workflow_validation_source(w uuid,run uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE snapshot jsonb;
BEGIN
 IF workflow_history_evidence_visible(run) IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM workflow_runs r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.vars#>'{__contextScopeEvidence,sources}','[]'::jsonb)) s
  WHERE r.workspace_id=w AND r.id=run AND s->>'resourceKind'=k AND s->>'resourceId'=i::text
 ) THEN RETURN jsonb_build_object('held',true); END IF;
 snapshot:=read_scope_source(w,k,i);
 -- D1: an authorized historical read survives deletion/retraction, without
 -- exposing the current envelope of retracted content.
 IF snapshot IS NOT NULL AND (snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL) THEN
  RETURN jsonb_build_object('held',false,'validTo',snapshot->'validTo','retractedAt',snapshot->'retractedAt');
 END IF;
 RETURN snapshot;
EXCEPTION WHEN raise_exception OR invalid_text_representation OR invalid_parameter_value THEN RETURN jsonb_build_object('held',true);
END $$;
COMMIT;
