BEGIN;
-- [COMP:workflow/context-scope] Protection version for workflow descendants.
ALTER TABLE workflow_runs ADD COLUMN derivation_source_version bigint NOT NULL DEFAULT 1;
ALTER TABLE workflow_runs ADD COLUMN derivation_lineage_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION workflow_derivation_source_fields(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_array(r->'workflow_id',r->'workspace_id',r->'triggered_by',r->'trigger_kind',
   r->'context_group_id',r->'context_project_id',r->'context_compartments',r->'context_project_ids',
   r->'derivation_lineage_revision',r->'execution_authority',r->'input',r->'crm_event_id',r->'source_goal_id',r->'privacy_erased',
   r#>'{vars,__contextScopeEvidence}',
   coalesce(r->>'status'='failed' AND r#>>'{error,reason}'='workflow_cancelled',false))
$$;
CREATE FUNCTION advance_workflow_derivation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 NEW.derivation_source_version:=OLD.derivation_source_version+CASE WHEN
   workflow_derivation_source_fields(to_jsonb(NEW)) IS DISTINCT FROM workflow_derivation_source_fields(to_jsonb(OLD))
   THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
CREATE FUNCTION invalidate_workflow_derivation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.derivation_source_version IS DISTINCT FROM OLD.derivation_source_version THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
    AND EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=OLD.workspace_id
      AND source_kind='workflow_run' AND source_id=OLD.id) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'workflow_run',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_derivation_version BEFORE UPDATE ON workflow_runs
 FOR EACH ROW EXECUTE FUNCTION advance_workflow_derivation_source();
CREATE TRIGGER workflow_derivation_changed AFTER UPDATE ON workflow_runs
 FOR EACH ROW EXECUTE FUNCTION invalidate_workflow_derivation_source();
CREATE TRIGGER workflow_derivation_deleted BEFORE DELETE ON workflow_runs
 FOR EACH ROW EXECUTE FUNCTION invalidate_workflow_derivation_source();
CREATE FUNCTION advance_workflow_parent_derivations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='workflows' THEN
  IF ROW(NEW.workspace_id,NEW.created_by,NEW.context_group_id,NEW.context_project_id,NEW.authoring_authority)
   IS DISTINCT FROM ROW(OLD.workspace_id,OLD.created_by,OLD.context_group_id,OLD.context_project_id,OLD.authoring_authority) THEN
   UPDATE workflow_runs SET derivation_lineage_revision=derivation_lineage_revision+1 WHERE workflow_id=NEW.id;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  UPDATE workflow_runs SET derivation_lineage_revision=derivation_lineage_revision+1 WHERE id=OLD.run_id AND workspace_id=OLD.workspace_id;
  RETURN OLD;
 END IF;
 UPDATE workflow_runs SET derivation_lineage_revision=derivation_lineage_revision+1 WHERE id=NEW.run_id AND workspace_id=NEW.workspace_id;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_parent_derivation_changed AFTER UPDATE ON workflows
 FOR EACH ROW EXECUTE FUNCTION advance_workflow_parent_derivations();
CREATE TRIGGER workflow_copy_derivation_added AFTER INSERT ON workflow_run_copy_sources
 FOR EACH ROW EXECUTE FUNCTION advance_workflow_parent_derivations();
CREATE TRIGGER workflow_copy_derivation_removed AFTER DELETE ON workflow_run_copy_sources
 FOR EACH ROW EXECUTE FUNCTION advance_workflow_parent_derivations();
REVOKE ALL ON FUNCTION advance_workflow_parent_derivations() FROM PUBLIC;
REVOKE ALL ON FUNCTION workflow_derivation_source_fields(jsonb),advance_workflow_derivation_source(),invalidate_workflow_derivation_source() FROM PUBLIC;
COMMIT;
