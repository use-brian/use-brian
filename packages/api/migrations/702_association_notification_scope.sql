BEGIN;
-- [COMP:crm/association-source-scope] Preserve canonical parent evidence, never backfill history.
ALTER TABLE association_notification_outbox ADD COLUMN scope_snapshot jsonb, ADD COLUMN scope_sources jsonb;
ALTER TABLE association_notification_outbox ADD CONSTRAINT association_notification_scope_shape CHECK (
 (scope_snapshot IS NULL AND scope_sources IS NULL) OR
 (scope_snapshot IS NOT NULL AND scope_sources IS NOT NULL
  AND jsonb_typeof(scope_snapshot)='object' AND jsonb_typeof(scope_sources)='array'
  AND (jsonb_array_length(scope_sources)>0 OR status='retired')
  AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
  AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  AND coalesce(scope_snapshot->>'sensitivity','') IN('public','internal','confidential')
  AND jsonb_typeof(scope_snapshot->'compartments')='array'
  AND jsonb_typeof(scope_snapshot->'projectIds')='array'));
CREATE FUNCTION association_notification_capture_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source_kind='order' THEN
   SELECT scope_snapshot,scope_sources INTO NEW.scope_snapshot,NEW.scope_sources
    FROM association_orders WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id;
  ELSIF NEW.source_kind='enquiry' THEN
   SELECT scope_snapshot,scope_sources INTO NEW.scope_snapshot,NEW.scope_sources
    FROM association_enquiries WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id;
  ELSE NEW.scope_snapshot=NULL; NEW.scope_sources=NULL;
  END IF;
 ELSE
  IF NEW.scope_snapshot IS DISTINCT FROM OLD.scope_snapshot THEN RAISE EXCEPTION 'notification scope is immutable'; END IF;
  IF NEW.status='retired' THEN NEW.scope_sources=CASE WHEN OLD.scope_sources IS NULL THEN NULL ELSE '[]'::jsonb END;
  ELSIF NEW.scope_sources IS DISTINCT FROM OLD.scope_sources THEN RAISE EXCEPTION 'notification sources are immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER association_notification_scope_capture BEFORE INSERT OR UPDATE ON association_notification_outbox
 FOR EACH ROW EXECUTE FUNCTION association_notification_capture_scope();
COMMIT;
