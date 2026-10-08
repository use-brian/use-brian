BEGIN;
-- [COMP:crm/file-cleanup] Spec: crm-operations.md, File cleanup department admission and saved receipts.
ALTER TABLE crm_import_file_cleanups ADD COLUMN scope_snapshot jsonb;
ALTER TABLE crm_import_file_cleanups ADD CONSTRAINT crm_import_file_cleanups_scope_shape CHECK (
  scope_snapshot IS NULL OR (
    jsonb_typeof(scope_snapshot)='object'
    AND (scope_snapshot->>'workspaceId') IS NOT DISTINCT FROM workspace_id::text
    AND scope_snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND coalesce(scope_snapshot->>'sensitivity','') IN ('public','internal','confidential')
    AND jsonb_typeof(scope_snapshot->'compartments')='array'
    AND jsonb_typeof(scope_snapshot->'projectIds')='array'
  )
);
CREATE OR REPLACE FUNCTION public.crm_import_file_cleanup_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.owner_user_id IS NULL AND to_jsonb(NEW)-'owner_user_id'=to_jsonb(OLD)-'owner_user_id' THEN RETURN NEW; END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.owner_user_id,NEW.file_id,NEW.before_at,NEW.policy_version,NEW.snapshot_hash,
    NEW.preview_hash,NEW.summary,NEW.created_at,NEW.expires_at,NEW.scope_snapshot)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.owner_user_id,OLD.file_id,OLD.before_at,OLD.policy_version,OLD.snapshot_hash,
    OLD.preview_hash,OLD.summary,OLD.created_at,OLD.expires_at,OLD.scope_snapshot)
    OR NOT((OLD.status='ready' AND NEW.status='queued')
      OR (OLD.status IN('queued','failed') AND NEW.status='leased')
      OR (OLD.status='leased' AND NEW.status IN('completed','failed'))
      OR (OLD.status='leased' AND NEW.status='leased' AND OLD.leased_until<=clock_timestamp()))
  THEN RAISE EXCEPTION 'CRM file cleanup identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.queued_at IS NOT NULL AND ROW(NEW.queued_at,NEW.replay_expires_at) IS DISTINCT FROM ROW(OLD.queued_at,OLD.replay_expires_at)
    OR (OLD.storage_uri IS NOT NULL AND NEW.storage_uri IS DISTINCT FROM OLD.storage_uri AND NEW.status<>'completed')
  THEN RAISE EXCEPTION 'CRM file cleanup target is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE POLICY crm_file_cleanup_department_read ON crm_import_file_cleanups AS RESTRICTIVE FOR SELECT USING(
 NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=crm_import_file_cleanups.workspace_id AND w.department_read_v2)
 OR (scope_snapshot IS NOT NULL AND department_member_source_allows(
  nullif(current_setting('app.current_user_id',true),'')::uuid,workspace_id,scope_snapshot->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(scope_snapshot->'compartments')),(scope_snapshot->>'userId')::uuid)
  AND agent_visibility_allows(workspace_id,(scope_snapshot->>'userId')::uuid,(scope_snapshot->>'assistantId')::uuid))
);
COMMIT;
