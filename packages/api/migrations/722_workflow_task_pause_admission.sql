BEGIN;
-- [COMP:api/workflow-input-evidence] A storm pause is also a dispatch effect.
CREATE TABLE workflow_task_pause_admissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
 valid_until timestamptz,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE workflow_task_pause_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow_task_pause_admissions FROM PUBLIC;
CREATE FUNCTION enforce_workflow_task_pause_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.valid_until IS NOT NULL AND clock_timestamp()>=NEW.valid_until THEN
  RAISE EXCEPTION 'workflow_dispatch_expired' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enforce_workflow_task_pause_boundary() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER workflow_task_pause_boundary AFTER INSERT ON workflow_task_pause_admissions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_workflow_task_pause_boundary();
COMMIT;
