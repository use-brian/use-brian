BEGIN;
-- [COMP:api/workflow-input-evidence] No historical evidence backfill.
ALTER TABLE workflow_run_copy_sources ADD COLUMN run_scope_evidence jsonb;
ALTER TABLE workflow_run_copy_sources ADD COLUMN run_source_version bigint;
CREATE FUNCTION capture_workflow_copy_scope_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source workflow_runs;
BEGIN
 SELECT * INTO source FROM workflow_runs
  WHERE workspace_id=NEW.workspace_id AND id=NEW.source_run_id FOR SHARE;
 NEW.run_source_version:=source.derivation_source_version;
 NEW.run_scope_evidence:=CASE WHEN jsonb_typeof(source.vars->'__contextScopeEvidence')='object'
  THEN source.vars->'__contextScopeEvidence' ELSE NULL END;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_copy_scope_evidence BEFORE INSERT ON workflow_run_copy_sources
 FOR EACH ROW EXECUTE FUNCTION capture_workflow_copy_scope_evidence();
REVOKE ALL ON FUNCTION capture_workflow_copy_scope_evidence() FROM PUBLIC;
COMMIT;
