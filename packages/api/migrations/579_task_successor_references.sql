BEGIN;

CREATE FUNCTION guard_task_successor_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- A later statement may have removed or restored the row. Only enforce a
  -- source that is still retired to this successor at the transaction boundary.
  IF EXISTS(SELECT 1 FROM tasks WHERE id=NEW.id AND workspace_id=NEW.workspace_id
      AND valid_to IS NOT NULL AND superseded_by=NEW.superseded_by)
    AND (EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND parent_id=NEW.id
          AND valid_to IS NULL AND retracted_at IS NULL)
      OR EXISTS(SELECT 1 FROM goals WHERE workspace_id=NEW.workspace_id AND host_type='task' AND host_id=NEW.id)) THEN
    RAISE EXCEPTION 'task_reference_conflict';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tasks_successor_references
AFTER UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN(OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND NEW.superseded_by IS NOT NULL)
EXECUTE FUNCTION guard_task_successor_references();

COMMIT;
