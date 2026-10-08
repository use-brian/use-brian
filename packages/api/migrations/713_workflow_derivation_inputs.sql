BEGIN;
-- [COMP:api/workflow-input-evidence] Internal locked metadata, not an access grant.
CREATE FUNCTION read_workflow_derivation_inputs(w uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[]; r workflow_runs; parent workflows; c workflow_run_copy_sources;
 evidence jsonb; result jsonb:='[]'; enrichment jsonb; record_id uuid; department text;
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (
  WITH RECURSIVE lineage(id) AS (
   SELECT id FROM workflow_runs WHERE workspace_id=w AND id=target
   UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id WHERE s.workspace_id=w
  ) SELECT id FROM lineage
 ) walk;
 IF ids IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
 -- Deterministic locks cover source mutation and copy-receipt changes through
 -- the lineage revision trigger. Each caller retains them through admission.
 PERFORM id FROM workflow_runs WHERE workspace_id=w AND id=ANY(ids) ORDER BY id FOR SHARE;
 FOR r IN SELECT * FROM workflow_runs WHERE workspace_id=w AND id=ANY(ids) ORDER BY id LOOP
  evidence:=r.vars->'__contextScopeEvidence';
  IF r.privacy_erased OR (r.status='failed' AND r.error->>'reason'='workflow_cancelled')
   OR evidence IS NULL OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
   OR coalesce(evidence->>'sensitivity','') NOT IN('public','internal','confidential')
   OR jsonb_typeof(evidence->'compartments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(evidence->'projectIds') IS DISTINCT FROM 'array'
   OR (evidence ? 'sources' AND jsonb_typeof(evidence->'sources') IS DISTINCT FROM 'array')
   THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  SELECT * INTO parent FROM workflows WHERE workspace_id=w AND id=r.workflow_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  department:=NULL;
  IF parent.context_group_id IS NOT NULL THEN
   SELECT compartment_key INTO department FROM workspace_groups WHERE workspace_id=w AND id=parent.context_group_id AND kind='team' FOR SHARE;
   IF department IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  END IF;
  IF r.context_group_id IS NOT NULL AND NOT ('team:'||r.context_group_id::text)=ANY(r.context_compartments)
   THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  SELECT id INTO record_id FROM blueprint_records WHERE workspace_id=w AND source_kind IN('workflow','research')
   AND source_id=r.id::text ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE;
  enrichment:=CASE WHEN record_id IS NULL THEN 'null'::jsonb ELSE read_scope_source(w,'blueprint_record',record_id) END;
  result:=result||jsonb_build_array(jsonb_build_object(
   'runId',r.id,'version',r.derivation_source_version::text,'workflowId',r.workflow_id,
   'actorId',coalesce(r.triggered_by,parent.created_by),'executionAuthority',r.execution_authority,
   'evidence',evidence,'savedContext',jsonb_build_object('compartments',r.context_compartments,'projectIds',r.context_project_ids),
   'blueprintSource',CASE WHEN record_id IS NULL THEN 'null'::jsonb ELSE enrichment END,
   'currentContext',jsonb_build_object('compartments',CASE WHEN department IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(department) END,
    'projectIds',CASE WHEN parent.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(parent.context_project_id) END)));
 END LOOP;
 FOR c IN SELECT * FROM workflow_run_copy_sources WHERE workspace_id=w AND run_id=ANY(ids) ORDER BY run_id,source_run_id FOR SHARE LOOP
  SELECT * INTO r FROM workflow_runs WHERE workspace_id=w AND id=c.source_run_id;
  IF NOT FOUND OR NOT r.id=ANY(ids) OR c.run_source_version IS DISTINCT FROM r.derivation_source_version
   OR c.run_scope_evidence IS NULL OR c.run_scope_evidence IS DISTINCT FROM r.vars->'__contextScopeEvidence'
   OR c.blueprint_source IS NULL THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
  SELECT id INTO record_id FROM blueprint_records WHERE workspace_id=w AND source_kind IN('workflow','research')
   AND source_id=c.source_run_id::text ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE;
  enrichment:=CASE WHEN record_id IS NULL THEN 'null'::jsonb ELSE read_scope_source(w,'blueprint_record',record_id) END;
  IF c.blueprint_source IS DISTINCT FROM enrichment THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs(uuid,uuid) FROM PUBLIC;
COMMIT;
