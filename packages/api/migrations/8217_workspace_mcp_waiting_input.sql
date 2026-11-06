BEGIN;
ALTER TABLE workspace_mcp_operations DROP CONSTRAINT workspace_mcp_operations_status_check;
ALTER TABLE workspace_mcp_operations ADD CONSTRAINT workspace_mcp_operations_status_check
 CHECK(status IN('running','succeeded','failed','waiting_approval','waiting_input','uncertain'));
COMMIT;
