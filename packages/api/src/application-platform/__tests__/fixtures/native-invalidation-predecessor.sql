-- Minimal exact historical invalidation dependency, installed only in a rollback fixture.
CREATE TABLE native_crm_current_cohorts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 type_key text NOT NULL CHECK(type_key IN('person','company','deal')),
 eligible boolean NOT NULL,groups jsonb NOT NULL,PRIMARY KEY(workspace_id,type_key));
ALTER TABLE native_crm_current_cohorts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON native_crm_current_cohorts FROM PUBLIC,app_user;
CREATE FUNCTION invalidate_native_crm_cohorts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
BEGIN
 IF TG_TABLE_NAME='application_field_observations' THEN
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM native_crm_projection_facts f WHERE f.workspace_id=NEW.workspace_id AND f.resource_id=NEW.resource_id) THEN RETURN NULL;END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN UPDATE native_crm_current_cohorts SET eligible=false WHERE workspace_id=OLD.workspace_id AND eligible;END IF;
 IF TG_OP<>'DELETE' THEN UPDATE native_crm_current_cohorts SET eligible=false WHERE workspace_id=NEW.workspace_id AND eligible;END IF;
 RETURN NULL;
END $fixture$;
REVOKE ALL ON FUNCTION invalidate_native_crm_cohorts() FROM PUBLIC,app_user;
CREATE TRIGGER native_crm_cohort_invalidate AFTER INSERT OR UPDATE OR DELETE ON scope_derivation_sources
FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts();
CREATE TRIGGER native_crm_cohort_invalidate AFTER INSERT OR UPDATE OR DELETE ON scope_derivations
FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts();
