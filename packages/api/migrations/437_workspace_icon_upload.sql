-- [COMP:api/workspace-icon]
-- One admin-uploaded workspace picture with immutable storage provenance.
-- `icon_seed` remains the generated landmark fallback when these are NULL.

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS icon_url TEXT,
  ADD COLUMN IF NOT EXISTS icon_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS icon_storage_uri TEXT;

COMMENT ON COLUMN workspaces.icon_url IS
  'Versioned public /api/workspace-icons/:workspaceId proxy URL; NULL uses icon_seed.';
COMMENT ON COLUMN workspaces.icon_storage_key IS
  'Object key of the uploaded workspace icon; also the replacement CAS token.';
COMMENT ON COLUMN workspaces.icon_storage_uri IS
  'Immutable gs://, s3://, or file:// origin used to route icon reads and cleanup.';

COMMIT;
