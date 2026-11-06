BEGIN;
ALTER TABLE workspace_mcp_runs ADD COLUMN turn_operation_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE workspace_mcp_operations ADD COLUMN run_id uuid REFERENCES workspace_mcp_runs(id) ON DELETE CASCADE;
CREATE INDEX workspace_mcp_operation_run ON workspace_mcp_operations(run_id) WHERE run_id IS NOT NULL;
COMMIT;
