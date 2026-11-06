BEGIN;
CREATE TABLE workspace_mcp_contexts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 brain_key_id uuid UNIQUE REFERENCES brain_keys(id) ON DELETE CASCADE,
 api_key_id uuid UNIQUE REFERENCES api_keys(id) ON DELETE CASCADE,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 invalidated boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((brain_key_id IS NULL) <> (api_key_id IS NULL))
);
CREATE TABLE workspace_mcp_operations (
 id uuid NOT NULL,
 context_id uuid NOT NULL REFERENCES workspace_mcp_contexts(id) ON DELETE CASCADE,
 operation_name text NOT NULL,
 argument_hash text NOT NULL,
 status text NOT NULL CHECK (status IN ('running','succeeded','failed','waiting_approval','uncertain')),
 result jsonb,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(context_id,id)
);
CREATE INDEX workspace_mcp_operations_recent ON workspace_mcp_operations(context_id,started_at DESC);
ALTER TABLE workspace_mcp_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_mcp_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_mcp_context_actor ON workspace_mcp_contexts
 USING(user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
ALTER TABLE workspace_mcp_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_mcp_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_mcp_operation_actor ON workspace_mcp_operations
 USING(EXISTS(SELECT 1 FROM workspace_mcp_contexts c WHERE c.id=context_id))
 WITH CHECK(EXISTS(SELECT 1 FROM workspace_mcp_contexts c WHERE c.id=context_id));
COMMIT;
