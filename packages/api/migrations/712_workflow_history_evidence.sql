BEGIN;
-- [COMP:workflow/context-scope] Saved/current evidence before rows or counts.
CREATE FUNCTION workflow_evidence_envelope_visible(w uuid,s jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 teams text[]; projects uuid[]; grants jsonb; v2 boolean;
BEGIN
 IF actor IS NULL OR jsonb_typeof(s)<>'object' OR s->>'workspaceId' IS DISTINCT FROM w::text
  OR NOT(s ?& ARRAY['sensitivity','compartments','projectIds','userId','assistantId'])
  OR coalesce(s->>'sensitivity','') NOT IN('public','internal','confidential')
  OR jsonb_typeof(s->'compartments') IS DISTINCT FROM 'array'
  OR jsonb_typeof(s->'projectIds') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'compartments') x WHERE jsonb_typeof(x)<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'projectIds') x WHERE jsonb_typeof(x)<>'string')
  OR (s->>'userId' IS NOT NULL AND s->>'userId'<>actor::text)
  OR (s->>'userId' IS NOT NULL AND current_setting('app.agent_shared_audience',true)='true')
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  THEN RETURN false; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid);
 IF agent_visibility_allows(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid) IS NOT TRUE
  OR agent_scope_grant_allows('app.agent_project_ids',projects::text[]) IS NOT TRUE THEN RETURN false; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w;
 IF v2 THEN
  grants:=department_read_grants();
  IF NOT(grants ? w::text) OR department_row_allows(grants,w,s->>'sensitivity',teams,(s->>'userId')::uuid) IS NOT TRUE THEN RETURN false; END IF;
  IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
    AND current_setting('app.v2_active',true) IS DISTINCT FROM 'true'
    AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
   IF cardinality(teams)>0 AND nullif(current_setting('app.agent_compartments',true),'') IS NULL THEN RETURN false; END IF;
   IF agent_read_scope_allows(s->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN false; END IF;
  END IF;
 ELSE
  IF member_operation_scope_allows(w,s->>'sensitivity',teams,false) IS NOT TRUE
    OR agent_read_scope_allows(s->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;

CREATE FUNCTION workflow_scope_evidence_visible(w uuid,e jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; live jsonb;
BEGIN
 IF e IS NULL OR jsonb_typeof(e) IS DISTINCT FROM 'object'
   OR workflow_evidence_envelope_visible(w,e||jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL)) IS NOT TRUE
   OR (e ? 'sources' AND jsonb_typeof(e->'sources') IS DISTINCT FROM 'array') THEN RETURN false; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(coalesce(e->'sources','[]'::jsonb)) LOOP
  IF NOT(s ?& ARRAY['resourceKind','resourceId','version'])
    OR jsonb_typeof(s->'resourceKind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'resourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(s->'version') IS DISTINCT FROM 'string'
    OR workflow_evidence_envelope_visible(w,s) IS NOT TRUE THEN RETURN false; END IF;
  live:=read_scope_source(w,s->>'resourceKind',(s->>'resourceId')::uuid);
  IF live IS NULL THEN
   IF s->>'resourceKind'='crm_event' THEN RETURN false; END IF;
   CONTINUE; -- D1: deletion does not erase saved restrictions.
  END IF;
  IF live->>'held' IS DISTINCT FROM 'false' THEN RETURN false; END IF;
  IF live->>'validTo' IS NOT NULL OR live->>'retractedAt' IS NOT NULL THEN CONTINUE; END IF;
  IF workflow_evidence_envelope_visible(w,live) IS NOT TRUE THEN RETURN false; END IF;
  IF s->>'resourceKind'='crm_event' AND (live->>'version' IS DISTINCT FROM s->>'version'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e->'sources') parent
      WHERE parent->>'resourceKind'='entity' AND parent->>'resourceId'=live->>'causalEntityId')) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN false;
END $$;

CREATE FUNCTION workflow_history_evidence_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record; c record;
BEGIN
 IF workflow_run_department_visible(target) IS NOT TRUE OR workflow_crm_scope_visible(target) IS NOT TRUE THEN RETURN false; END IF;
 FOR r IN WITH RECURSIVE lineage(id) AS (
   SELECT id FROM workflow_runs WHERE id=target
   UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
  ) SELECT wr.* FROM lineage l JOIN workflow_runs wr ON wr.id=l.id
 LOOP
  -- Missing historical/uncaptured evidence is not an empty General envelope.
  IF workflow_scope_evidence_visible(r.workspace_id,r.vars->'__contextScopeEvidence') IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 FOR c IN WITH RECURSIVE lineage(id) AS (
   SELECT id FROM workflow_runs WHERE id=target
   UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
  ) SELECT s.*,wr.derivation_source_version,wr.vars FROM lineage l
    JOIN workflow_run_copy_sources s ON s.run_id=l.id
    LEFT JOIN workflow_runs wr ON wr.id=s.source_run_id AND wr.workspace_id=s.workspace_id
 LOOP
  IF c.run_source_version IS DISTINCT FROM c.derivation_source_version
    OR c.run_scope_evidence IS DISTINCT FROM c.vars->'__contextScopeEvidence'
    OR workflow_scope_evidence_visible(c.workspace_id,c.run_scope_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION workflow_evidence_envelope_visible(uuid,jsonb),workflow_scope_evidence_visible(uuid,jsonb) FROM PUBLIC;
CREATE POLICY workflow_runs_accumulated_evidence ON workflow_runs AS RESTRICTIVE FOR SELECT USING(workflow_history_evidence_visible(id));
CREATE POLICY workflow_steps_accumulated_evidence ON workflow_step_runs AS RESTRICTIVE FOR SELECT USING(workflow_history_evidence_visible(run_id));
CREATE POLICY workflow_copies_accumulated_evidence ON workflow_run_copy_sources AS RESTRICTIVE FOR SELECT
 USING(workflow_history_evidence_visible(run_id) AND workflow_history_evidence_visible(source_run_id));
COMMIT;
