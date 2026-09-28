-- 604_workspace_decision_routing.sql  (OPEN table)
--
-- Workspace-level decision classifier preference. No row leaves the edition's
-- injected policy in control (LLM-only by default); explicit `llm_only` is a
-- safe workspace override. A selected alias enables bounded shadow sampling;
-- hybrid promotion remains operation-specific and is never stored here.

BEGIN;

CREATE TABLE workspace_decision_routing (
  workspace_id       UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('llm_only', 'shadow')),
  model_alias        TEXT,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (mode = 'llm_only' AND model_alias IS NULL)
    OR (mode = 'shadow' AND model_alias IS NOT NULL)
  )
);

-- Members can read the setting. The route layer restricts writes to owners
-- and admins; runtime resolution uses the system pool after workspace scope
-- has already been captured by the caller.
ALTER TABLE workspace_decision_routing ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_decision_routing_workspace_member ON workspace_decision_routing
  USING (workspace_id IN (
    SELECT workspace_members.workspace_id
      FROM workspace_members
     WHERE workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid
  ));

COMMIT;
