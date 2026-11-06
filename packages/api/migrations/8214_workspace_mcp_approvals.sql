BEGIN;
ALTER TABLE workspace_mcp_operations
 ADD COLUMN delegation jsonb,
 ADD COLUMN approval_id uuid UNIQUE REFERENCES pending_approvals(id),
 ADD COLUMN resumed_at timestamptz;
-- The private operation relation is authoritative. The public approval marker
-- only prevents an older session-resume consumer from dropping parent proof.
CREATE INDEX workspace_mcp_operation_approval ON workspace_mcp_operations(approval_id) WHERE approval_id IS NOT NULL;
COMMIT;
