-- 411_kb_maintenance_agents.sql (OPEN tables -> packages/api/migrations/)
-- Self-maintaining knowledge base: per-source maintenance agent config
-- (docs/architecture/features/knowledge-base.md -> "Self-maintain agents").
--
-- One row per source. Enabling materializes a system-managed workflow
-- (workflows.managed_by = 'knowledge') whose writes pause into the
-- Approvals inbox (suggestion-first; the workflow executor's existing
-- `workflow_step` approval is the gate). The mandatory fields are the
-- anti-slop contract: every one is required at enable time.

BEGIN;

CREATE TABLE kb_maintenance_agents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id                UUID NOT NULL UNIQUE REFERENCES workspace_knowledge_sources(id) ON DELETE CASCADE,
  -- The materialized workflow. SET NULL (not CASCADE) so a deleted workflow
  -- leaves the config visible as "broken - re-enable to rebuild".
  workflow_id              UUID REFERENCES workflows(id) ON DELETE SET NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  -- What this KB documents and what is explicitly out of scope. The judge
  -- criterion for every proposal. Non-trivial minimum length.
  charter                  TEXT NOT NULL CHECK (length(charter) >= 40),
  -- Path prefixes (relative to the source root) the agent may touch.
  path_scope               TEXT[] NOT NULL CHECK (array_length(path_scope, 1) >= 1),
  -- Which signals wake the agent: { "knowledgeEvents": bool, "cronTime": "HH:MM" | null }
  signals                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Update-over-create: a new entry is allowed only when no existing entry
  -- matches above this similarity (judged against searchKnowledge results).
  similarity_threshold     REAL NOT NULL DEFAULT 0.8
                             CHECK (similarity_threshold > 0 AND similarity_threshold <= 1),
  -- Authoring style rules injected into the judge prompt.
  style_contract           TEXT NOT NULL CHECK (length(style_contract) >= 20),
  -- Max tier the agent may stamp on a create. Updates never reclassify.
  sensitivity_ceiling      TEXT NOT NULL DEFAULT 'internal'
                             CHECK (sensitivity_ceiling IN ('public', 'internal', 'confidential')),
  -- Hard spam brake: attempted write-proposals per rolling 7 days.
  weekly_proposal_budget   INT NOT NULL DEFAULT 5
                             CHECK (weekly_proposal_budget >= 1 AND weekly_proposal_budget <= 100),
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kbma_workspace ON kb_maintenance_agents(workspace_id);
CREATE INDEX idx_kbma_workflow ON kb_maintenance_agents(workflow_id);

ALTER TABLE kb_maintenance_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY kbma_member ON kb_maintenance_agents USING ((workspace_id IN (
  SELECT workspace_members.workspace_id
  FROM workspace_members
  WHERE workspace_members.user_id = (current_setting('app.current_user_id', true))::uuid
)));

-- System-managed marker on workflows: non-NULL = owned by a product feature
-- (v1 value: 'knowledge'). Managed workflows reject hand-edits of their
-- definition/trigger through the builder PATCH route; edits go through the
-- owning feature's config UI, which re-materializes the definition.
ALTER TABLE workflows
  ADD COLUMN managed_by TEXT
    CHECK (managed_by IS NULL OR managed_by IN ('knowledge'));

COMMIT;
