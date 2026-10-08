BEGIN;
-- [COMP:sandbox/task-publication] Bound canonical host renewal through COMMIT.
CREATE TABLE workspace_file_workflow_admissions (
  file_id uuid NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  valid_until timestamptz,
  PRIMARY KEY(file_id,run_id)
);
ALTER TABLE workspace_file_workflow_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workspace_file_workflow_admissions FROM PUBLIC;

CREATE FUNCTION capture_workflow_file_temporal_boundary(w uuid,r uuid,f uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  authority jsonb; assistants uuid[]; captured timestamptz; boundary timestamptz;
BEGIN
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_files
    WHERE id=f AND workspace_id=w AND created_by_user_id=actor) THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501'; END IF;
  PERFORM lock_workflow_authority_inputs(w,r);
  SELECT execution_authority INTO authority FROM workflow_runs WHERE id=r AND workspace_id=w;
  IF authority IS NULL THEN RAISE EXCEPTION 'workflow_authority_unavailable' USING ERRCODE='42501'; END IF;
  assistants:=array_remove(ARRAY[(authority->>'assistantId')::uuid,
    (authority#>>'{workflowAuthoringAuthority,assistantId}')::uuid,
    (authority#>>'{sourceGoal,authoringAuthority,assistantId}')::uuid],NULL);
  captured:=clock_timestamp();
  SELECT min(expiry) INTO boundary FROM (
    SELECT expires_at AS expiry FROM department_edges
      WHERE workspace_id=w AND (user_id=actor OR assistant_id=ANY(assistants)) AND expires_at>captured
    UNION ALL
    SELECT g.expires_at FROM workspace_access_grants g
      WHERE g.workspace_id=w AND g.revoked_at IS NULL AND g.starts_at<=captured AND g.expires_at>captured
        AND ((g.beneficiary_kind='member' AND g.beneficiary_id=actor)
          OR (g.beneficiary_kind='team' AND EXISTS(SELECT 1 FROM workspace_group_members m
            JOIN workspace_groups t ON t.id=m.group_id
            WHERE m.user_id=actor AND m.group_id=g.beneficiary_id AND t.workspace_id=w AND t.status='active')))
  ) expirations;
  INSERT INTO workspace_file_workflow_admissions(file_id,run_id,captured_at,valid_until)
    VALUES(f,r,captured,boundary);
END $$;

CREATE FUNCTION enforce_workflow_file_temporal_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.valid_until IS NOT NULL AND clock_timestamp()>=NEW.valid_until THEN
    RAISE EXCEPTION 'workflow_publication_expired' USING ERRCODE='42501'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enforce_workflow_file_temporal_boundary() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER workflow_file_temporal_boundary AFTER INSERT ON workspace_file_workflow_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_workflow_file_temporal_boundary();
COMMIT;
