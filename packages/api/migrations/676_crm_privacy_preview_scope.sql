BEGIN;
-- [COMP:crm/privacy-previews] Preserve subject protection after erasure without a copied identity list.
ALTER TABLE crm_privacy_previews ADD COLUMN scope_snapshot jsonb;
ALTER TABLE crm_privacy_previews ADD CONSTRAINT crm_privacy_previews_scope_shape CHECK (
  scope_snapshot IS NULL OR (
    jsonb_typeof(scope_snapshot)='object'
    AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
    AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND coalesce(scope_snapshot->>'sensitivity','') IN ('public','internal','confidential')
    AND jsonb_typeof(scope_snapshot->'compartments')='array'
    AND jsonb_typeof(scope_snapshot->'projectIds')='array'
  )
);
CREATE OR REPLACE FUNCTION public.crm_privacy_preview_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status<>'ready' OR NEW.status<>'consumed'
    OR ROW(NEW.id,NEW.workspace_id,NEW.owner_user_id,NEW.request_hash,NEW.snapshot_hash,NEW.preview_hash,
      NEW.policy_version,NEW.domain_summary,NEW.blockers,NEW.created_at,NEW.expires_at,NEW.scope_snapshot)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.owner_user_id,OLD.request_hash,OLD.snapshot_hash,OLD.preview_hash,
      OLD.policy_version,OLD.domain_summary,OLD.blockers,OLD.created_at,OLD.expires_at,OLD.scope_snapshot)
  THEN RAISE EXCEPTION 'CRM privacy previews are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
COMMIT;
