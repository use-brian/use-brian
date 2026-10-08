BEGIN;
-- [COMP:crm/provider-inbox] Historical provider evidence is not relabeled.
ALTER TABLE association_integration_events ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
ALTER TABLE association_integration_events ADD CONSTRAINT provider_receipt_scope_shape CHECK (
 (scope_snapshot IS NULL AND scope_sources IS NULL) OR
 (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
  AND jsonb_typeof(scope_snapshot)='object' AND jsonb_typeof(scope_sources)='array'
  AND jsonb_array_length(scope_sources)>0
  AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
  AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  AND coalesce(scope_snapshot->>'sensitivity','') IN('public','internal','confidential')
  AND jsonb_typeof(scope_snapshot->'compartments')='array'
  AND jsonb_typeof(scope_snapshot->'projectIds')='array'));
CREATE FUNCTION preserve_provider_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot OR NEW.scope_sources IS DISTINCT FROM OLD.scope_sources THEN
  RAISE EXCEPTION 'provider receipt scope is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_receipt_scope_immutable BEFORE UPDATE ON association_integration_events
 FOR EACH ROW EXECUTE FUNCTION preserve_provider_receipt_scope();
COMMIT;
