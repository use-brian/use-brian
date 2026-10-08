BEGIN;
-- [COMP:crm/association-promotions] Scope belongs to imported usage, not public configuration.
ALTER TABLE association_promotions ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
ALTER TABLE association_promotions ADD CONSTRAINT association_promotion_usage_scope_shape CHECK (
 (scope_snapshot IS NULL AND scope_sources IS NULL) OR
 (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
  AND jsonb_typeof(scope_snapshot)='object' AND jsonb_typeof(scope_sources)='array'
  AND jsonb_array_length(scope_sources)>0
  AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
  AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  AND coalesce(scope_snapshot->>'sensitivity','') IN('public','internal','confidential')
  AND jsonb_typeof(scope_snapshot->'compartments')='array'
  AND jsonb_typeof(scope_snapshot->'projectIds')='array'));
CREATE FUNCTION preserve_association_promotion_usage_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot OR NEW.scope_sources IS DISTINCT FROM OLD.scope_sources THEN
  RAISE EXCEPTION 'promotion usage scope is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER association_promotion_usage_scope_immutable BEFORE UPDATE ON association_promotions
 FOR EACH ROW EXECUTE FUNCTION preserve_association_promotion_usage_scope();
COMMIT;
