BEGIN;
-- [COMP:crm/association-promotions] Minimize identifiers only after canonical attribution erasure.
ALTER TABLE association_promotions ADD COLUMN scope_sources_minimized boolean NOT NULL DEFAULT false;
ALTER TABLE association_promotions DROP CONSTRAINT association_promotion_usage_scope_shape;
ALTER TABLE association_promotions ADD CONSTRAINT association_promotion_usage_scope_shape CHECK (
 (scope_snapshot IS NULL AND scope_sources IS NULL AND NOT scope_sources_minimized) OR
 (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
  AND jsonb_typeof(scope_snapshot)='object' AND jsonb_typeof(scope_sources)='array'
  AND (jsonb_array_length(scope_sources)>0 OR scope_sources_minimized)
  AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
  AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  AND coalesce(scope_snapshot->>'sensitivity','') IN('public','internal','confidential')
  AND jsonb_typeof(scope_snapshot->'compartments')='array'
  AND jsonb_typeof(scope_snapshot->'projectIds')='array'));
CREATE OR REPLACE FUNCTION preserve_association_promotion_usage_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining jsonb;
BEGIN
 IF NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot THEN RAISE EXCEPTION 'promotion usage scope is immutable'; END IF;
 IF NEW.scope_sources IS DISTINCT FROM OLD.scope_sources THEN
  SELECT coalesce(jsonb_agg(s.source ORDER BY s.ordinality),'[]'::jsonb) INTO remaining
   FROM jsonb_array_elements(OLD.scope_sources) WITH ORDINALITY s(source,ordinality)
   WHERE EXISTS(SELECT 1 FROM association_promotion_source_contact_uses u
    WHERE u.workspace_id=OLD.workspace_id AND u.promotion_id=OLD.id AND u.contact_id::text=s.source->>'resourceId');
  IF OLD.scope_sources IS NULL OR NEW.scope_sources IS DISTINCT FROM remaining OR NOT NEW.scope_sources_minimized THEN
   RAISE EXCEPTION 'promotion usage sources may only be minimized after attribution erasure';
  END IF;
 ELSIF NEW.scope_sources_minimized IS DISTINCT FROM OLD.scope_sources_minimized THEN
  RAISE EXCEPTION 'promotion usage minimization requires source removal';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION minimize_promotion_usage_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL THEN
  UPDATE association_promotions p SET scope_sources=(
    SELECT coalesce(jsonb_agg(s.source ORDER BY s.ordinality),'[]'::jsonb)
    FROM jsonb_array_elements(p.scope_sources) WITH ORDINALITY s(source,ordinality)
    WHERE EXISTS(SELECT 1 FROM association_promotion_source_contact_uses u
      WHERE u.workspace_id=p.workspace_id AND u.promotion_id=p.id AND u.contact_id::text=s.source->>'resourceId')),
    scope_sources_minimized=true
   WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.promotion_id AND p.scope_sources IS NOT NULL
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.scope_sources) s WHERE s->>'resourceId'=OLD.contact_id::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER association_promotion_usage_source_minimization AFTER UPDATE OF contact_id ON association_promotion_source_contact_uses
 FOR EACH ROW EXECUTE FUNCTION minimize_promotion_usage_sources();
COMMIT;
