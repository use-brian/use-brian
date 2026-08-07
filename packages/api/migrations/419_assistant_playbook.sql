-- Assistant playbook rules (docs/plans/assistant-growth-loop.md §3 Phase 3).
--
-- The mission-competence leg of the growth loop: the weekly reflection
-- worker grades an assistant's recent work against `charter.success` and
-- proposes rules here as status='suggested'. Nothing self-applies - the
-- owner admits ('active'), rejects, or later retires each rule (D8,
-- suggestion-first). Active rules render as the `## Playbook` section of
-- the `# Charter` prompt block, capped by PLAYBOOK_BLOCK_CHAR_CAP.
--
-- `provenance` records what taught the rule (session ids + the reflection
-- assessment) so the owner can judge it. Rejected rules are kept and fed
-- back to the reflection prompt so the worker stops re-proposing them.

BEGIN;

CREATE TABLE assistant_playbook_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK (length(rule) <= 280),
  rationale TEXT,
  provenance JSONB,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested', 'active', 'rejected', 'retired')),
  created_by TEXT NOT NULL DEFAULT 'reflection'
    CHECK (created_by IN ('reflection', 'owner')),
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  last_affirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_playbook_assistant_status
  ON assistant_playbook_rules (assistant_id, status);

COMMIT;
