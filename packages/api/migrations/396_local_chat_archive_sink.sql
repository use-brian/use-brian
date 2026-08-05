-- 396_local_chat_archive_sink.sql  (OPEN tables -> packages/api/migrations/)
--
-- Marks the one platform-managed, loopback-only brian-message-store sink per
-- connector instance. Manual external sinks keep managed_by NULL and are never
-- touched by local lifecycle reconciliation.

BEGIN;

ALTER TABLE ingest_external_sink
  ADD COLUMN managed_by TEXT;

ALTER TABLE ingest_external_sink
  ADD CONSTRAINT ingest_external_sink_managed_by_check
  CHECK (managed_by IS NULL OR managed_by = 'local_chat_archive');

CREATE UNIQUE INDEX idx_ingest_external_sink_managed_instance
  ON ingest_external_sink (connector_instance_id, managed_by)
  WHERE managed_by IS NOT NULL;

-- The live writer reuses an existing provider instance when one exists. This
-- partial identity applies only to its credential-free fallback rows, so real
-- multi-account connector instances remain unrestricted.
CREATE UNIQUE INDEX idx_connector_instance_local_archive_fallback
  ON connector_instance (workspace_id, provider)
  WHERE scope = 'workspace'
    AND config->>'managedBy' = 'local_chat_archive';

COMMIT;
