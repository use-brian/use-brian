BEGIN;

ALTER TABLE workflow_runs ADD COLUMN execution_authority jsonb;

CREATE FUNCTION enforce_workflow_run_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_id uuid;
  assistant_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.execution_authority IS NOT NULL
     AND NEW.execution_authority IS DISTINCT FROM OLD.execution_authority THEN
    RAISE EXCEPTION 'workflow_execution_authority_immutable';
  END IF;
  IF NEW.execution_authority IS NULL OR
     (TG_OP = 'UPDATE' AND NEW.execution_authority = OLD.execution_authority) THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.current_step_id IS NOT NULL OR NEW.vars <> '{}'::jsonb
     OR EXISTS(SELECT 1 FROM workflow_step_runs WHERE run_id=NEW.id) THEN
    RAISE EXCEPTION 'workflow_execution_authority_missing';
  END IF;
  SELECT COALESCE(NEW.triggered_by, w.created_by) INTO actor_id
    FROM workflows w WHERE w.id = NEW.workflow_id AND w.workspace_id = NEW.workspace_id;
  IF actor_id IS NULL OR jsonb_typeof(NEW.execution_authority) IS DISTINCT FROM 'object'
     OR NEW.execution_authority->>'version' IS DISTINCT FROM '1'
     OR NEW.execution_authority->'ceiling'->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
     OR NEW.execution_authority->'ceiling'->>'userId' IS DISTINCT FROM actor_id::text THEN
    RAISE EXCEPTION 'workflow_execution_authority_invalid';
  END IF;
  assistant_id := (NEW.execution_authority->>'assistantId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM assistants WHERE id=assistant_id AND workspace_id=NEW.workspace_id)
     OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor_id) THEN
    RAISE EXCEPTION 'workflow_execution_authority_invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_run_authority_guard BEFORE INSERT OR UPDATE ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION enforce_workflow_run_authority();

COMMIT;
