BEGIN;
-- Owner-pool sidecar. Hashes have no tenant-readable projection or RLS policy.
CREATE TABLE workspace_external_approval_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Keep the original binding for audit even if the assistant or human is removed.
  -- Runtime admission rechecks both records; a dangling binding is never authority.
  assistant_id uuid NOT NULL,
  approver_user_id uuid NOT NULL,
  channel_type text NOT NULL,
  channel_id text NOT NULL,
  channel_integration_id uuid,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  prefix text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_by uuid,
  rotated_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  CHECK ((channel_type='web' AND channel_id='queue' AND channel_integration_id IS NULL)
    OR (channel_type<>'web' AND channel_integration_id IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX workspace_external_approval_sources_workspace ON workspace_external_approval_sources(workspace_id,created_at);
ALTER TABLE workspace_external_approval_sources ENABLE ROW LEVEL SECURITY;
-- Defense in depth: a source namespace/binding can never be reused or revived.
CREATE FUNCTION preserve_external_approval_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- Workspace erasure must still cascade through credential metadata.
    IF EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'Approval sources must be revoked';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.assistant_id,NEW.approver_user_id,NEW.channel_type,NEW.channel_id,NEW.channel_integration_id,NEW.name,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.assistant_id,OLD.approver_user_id,OLD.channel_type,OLD.channel_id,OLD.channel_integration_id,OLD.name,OLD.created_by,OLD.created_at)
    OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Approval source binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_approval_source_binding BEFORE UPDATE OR DELETE ON workspace_external_approval_sources
  FOR EACH ROW EXECUTE FUNCTION preserve_external_approval_source_binding();
COMMIT;
