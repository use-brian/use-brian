BEGIN;
CREATE TABLE workspace_mcp_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 context_id uuid NOT NULL REFERENCES workspace_mcp_contexts(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 delegation jsonb NOT NULL,
 input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','waiting_approval','waiting_input','succeeded','failed','cancelled','uncertain')),
 result jsonb,
 claim_token uuid,
 heartbeat_at timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_mcp_run_active ON workspace_mcp_runs(context_id)
 WHERE status IN('queued','running','waiting_approval','waiting_input');
CREATE INDEX workspace_mcp_run_queue ON workspace_mcp_runs(created_at) WHERE status='queued';
ALTER TABLE workspace_mcp_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_mcp_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_mcp_run_actor ON workspace_mcp_runs
 USING(EXISTS(SELECT 1 FROM workspace_mcp_contexts c WHERE c.id=context_id))
 WITH CHECK(EXISTS(SELECT 1 FROM workspace_mcp_contexts c WHERE c.id=context_id));
COMMIT;
