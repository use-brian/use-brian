BEGIN;
-- [COMP:api/crm-integration-auth] Never infer historical issuance authority.
ALTER TABLE crm_integration_credentials ADD COLUMN department_binding jsonb;
ALTER TABLE crm_integration_credentials ADD CONSTRAINT crm_integration_department_binding_shape
  CHECK (department_binding IS NULL OR (
    jsonb_typeof(department_binding)='object'
    AND department_binding->>'version'='1'
    AND department_binding->>'workspaceId'=workspace_id::text
    AND jsonb_typeof(department_binding->'binding')='array'
    AND department_binding->>'cap' IN ('public','internal','confidential')
    AND department_binding ?& ARRAY['userId','assistantId','base','departments','contextDepartment']
  ));
CREATE FUNCTION public.crm_integration_binding_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.department_binding IS DISTINCT FROM OLD.department_binding THEN
    RAISE EXCEPTION 'CRM integration binding is immutable; issue a replacement credential';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_integration_binding_no_update BEFORE UPDATE OF department_binding
ON crm_integration_credentials FOR EACH ROW EXECUTE FUNCTION public.crm_integration_binding_immutable();
COMMIT;
