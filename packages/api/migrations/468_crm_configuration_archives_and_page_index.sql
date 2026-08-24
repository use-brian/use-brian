-- Reversible CRM configuration and the first keyset collection index.
-- Spec: docs/architecture/features/crm.md -> "Production system-of-record web contract".

BEGIN;

ALTER TABLE crm_pipelines ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE crm_pipeline_stages ADD COLUMN archived_at TIMESTAMPTZ;

DROP INDEX crm_pipelines_one_default;
ALTER TABLE crm_pipelines DROP CONSTRAINT crm_pipelines_workspace_id_name_key;
ALTER TABLE crm_pipeline_stages DROP CONSTRAINT crm_pipeline_stages_pipeline_id_name_key;
ALTER TABLE crm_pipeline_stages DROP CONSTRAINT crm_pipeline_stages_pipeline_id_position_key;

CREATE UNIQUE INDEX crm_pipelines_one_live_default
  ON crm_pipelines (workspace_id)
  WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX crm_pipelines_live_name
  ON crm_pipelines (workspace_id, name)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX crm_pipelines_live_position
  ON crm_pipelines (workspace_id, position)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX crm_pipeline_stages_live_name
  ON crm_pipeline_stages (pipeline_id, name)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX crm_pipeline_stages_live_position
  ON crm_pipeline_stages (pipeline_id, position)
  WHERE archived_at IS NULL;

CREATE INDEX entities_crm_keyset
  ON entities (workspace_id, kind, updated_at DESC, id DESC)
  WHERE valid_to IS NULL AND retracted_at IS NULL
    AND kind IN ('person', 'company', 'deal');

COMMIT;
