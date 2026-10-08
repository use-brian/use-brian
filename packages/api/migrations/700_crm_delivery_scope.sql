BEGIN;
-- [COMP:crm/delivery-receipts] No historical evidence backfill.
ALTER TABLE crm_delivery_receipts ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
ALTER TABLE crm_delivery_receipts ADD CONSTRAINT crm_delivery_scope_shape CHECK (
 (scope_snapshot IS NULL AND scope_sources IS NULL) OR
 (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
  AND jsonb_typeof(scope_snapshot)='object' AND jsonb_typeof(scope_sources)='array'
  AND (jsonb_array_length(scope_sources)>0 OR redacted_at IS NOT NULL)
  AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
  AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  AND coalesce(scope_snapshot->>'sensitivity','') IN('public','internal','confidential')
  AND jsonb_typeof(scope_snapshot->'compartments')='array'
  AND jsonb_typeof(scope_snapshot->'projectIds')='array'));
CREATE FUNCTION preserve_crm_delivery_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot THEN
  RAISE EXCEPTION 'delivery scope is immutable';
 END IF;
 IF NEW.redacted_at IS NOT NULL THEN NEW.scope_sources=CASE WHEN OLD.scope_sources IS NULL THEN NULL ELSE '[]'::jsonb END;
 ELSIF NEW.scope_sources IS DISTINCT FROM OLD.scope_sources THEN RAISE EXCEPTION 'delivery sources are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_delivery_scope_immutable BEFORE UPDATE ON crm_delivery_receipts
 FOR EACH ROW EXECUTE FUNCTION preserve_crm_delivery_scope();
COMMIT;
