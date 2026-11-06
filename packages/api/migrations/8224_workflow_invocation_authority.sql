-- [COMP:api/workflow-authority] Preserve the real caller across delayed work.
ALTER TABLE workflow_runs ADD COLUMN invocation_authority jsonb;
CREATE FUNCTION enforce_workflow_invocation_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.invocation_authority IS DISTINCT FROM OLD.invocation_authority THEN
  RAISE EXCEPTION 'workflow_invocation_authority_immutable';
 END IF;
 IF NEW.invocation_authority IS NOT NULL AND (
  NEW.invocation_authority->>'version' IS DISTINCT FROM '1'
  OR NEW.invocation_authority->'ceiling'->>'userId' IS DISTINCT FROM NEW.triggered_by::text
  OR NEW.invocation_authority->'ceiling'->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
 ) THEN RAISE EXCEPTION 'workflow_invocation_authority_invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_invocation_authority_guard BEFORE INSERT OR UPDATE ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION enforce_workflow_invocation_authority();
