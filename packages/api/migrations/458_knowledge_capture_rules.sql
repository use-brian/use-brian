-- 458_knowledge_capture_rules.sql (OPEN tables -> packages/api/migrations/)
-- Workspace-wide, default-off governance for interactive assistant KB writes.
-- See docs/architecture/features/knowledge-base.md -> "Workspace capture rules".

BEGIN;

CREATE TABLE knowledge_capture_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  match_phrases         TEXT[] NOT NULL
                          CHECK (cardinality(match_phrases) BETWEEN 1 AND 32),
  instructions          TEXT NOT NULL CHECK (length(btrim(instructions)) BETWEEN 1 AND 1000),
  -- NULL is the Manual entries pool. A source deletion removes the rule;
  -- it must never silently retarget a governed capture to Manual entries.
  target_source_id      UUID REFERENCES workspace_knowledge_sources(id) ON DELETE CASCADE,
  path_prefix           TEXT NOT NULL DEFAULT '' CHECK (length(path_prefix) <= 240),
  default_sensitivity   TEXT NOT NULL DEFAULT 'internal'
                          CHECK (default_sensitivity IN ('public', 'internal', 'confidential')),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_capture_rules_workspace
  ON knowledge_capture_rules(workspace_id, enabled, created_at);
CREATE INDEX idx_knowledge_capture_rules_target
  ON knowledge_capture_rules(target_source_id)
  WHERE target_source_id IS NOT NULL;

ALTER TABLE knowledge_capture_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_capture_rules_member ON knowledge_capture_rules
  USING ((workspace_id IN (
    SELECT workspace_members.workspace_id
    FROM workspace_members
    WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
  )));

COMMIT;
