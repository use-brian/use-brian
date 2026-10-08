BEGIN;
-- [COMP:crm/operations-store] Historical issuance evidence is never inferred.
ALTER TABLE crm_intake_credentials ADD COLUMN department_binding jsonb;
ALTER TABLE crm_intake_credentials ADD CONSTRAINT crm_intake_department_binding_shape
  CHECK (department_binding IS NULL OR (
    jsonb_typeof(department_binding)='object'
    AND department_binding->>'version'='1'
    AND department_binding->>'workspaceId'=workspace_id::text
    AND jsonb_typeof(department_binding->'binding')='array'
    AND department_binding->>'cap' IN ('public','internal','confidential')
    AND department_binding ?& ARRAY['userId','assistantId','base','departments','contextDepartment']
  ));
CREATE TRIGGER crm_intake_binding_no_update BEFORE UPDATE OF department_binding
ON crm_intake_credentials FOR EACH ROW EXECUTE FUNCTION public.crm_integration_binding_immutable();
COMMIT;
