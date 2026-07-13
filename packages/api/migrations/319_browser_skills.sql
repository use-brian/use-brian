-- 319_browser_skills.sql  (OPEN tables -> sidanclaw/packages/api/migrations/)
--
-- Computer use R2 (docs/architecture/engine/computer-use.md; plan R2-5/R2-9/R2-10):
--
--   browser_skills    Logic-blocks: executable CODE artifacts in brain -
--                     Python driving the governed browser runner (never the
--                     raw agent-browser CLI). Site-scoped + identity-agnostic
--                     (R2-10): the same block runs against any enabled+cleared
--                     profile for its site, chosen at call time. Every block
--                     carries its review artifact - the auto-extracted EFFECT
--                     CONTRACT (terminal send verbs; unknown constructs fail
--                     closed to flagged) and the authoring RECORDING
--                     (storyboard) - shown at grant time: the grant IS the
--                     review (R2-5). Blocks are immediately usable and gated
--                     by default: terminal sends queue as async approvals
--                     until a block+profile grant covers them.
--
--   pending_approvals Gains the 'auto_approved' status (R2-2): a satisfied
--                     block grant auto-approves the send but STILL writes an
--                     audit row - auto-approve is never invisible.

BEGIN;

CREATE TABLE browser_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Registrable domain the block drives (site-scoped, R2-10).
  site text NOT NULL CHECK (length(site) BETWEEN 1 AND 253),
  description text NOT NULL DEFAULT '',
  -- Python driving the governed runner (`runner.*` verbs only - the effect
  -- contract fail-closes anything else).
  code text NOT NULL,
  params_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The R2-5 review artifacts: effect contract + authoring storyboard.
  contract jsonb NOT NULL,
  recording jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  -- Where the block came from: the self-heal distiller, an in-product
  -- assistant authoring run, or an external agent via the brain-MCP write
  -- tool (the OSS authoring skill).
  origin text NOT NULL CHECK (origin IN ('self_heal', 'assistant', 'external')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX idx_browser_skills_workspace_site ON browser_skills (workspace_id, site);

ALTER TABLE browser_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY browser_skills_workspace_member ON browser_skills
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM workspace_members wm
    WHERE wm.user_id = (current_setting('app.current_user_id', true))::uuid));

-- ── pending_approvals: the auto-approve audit status (R2-2) ────

ALTER TABLE pending_approvals DROP CONSTRAINT pending_approvals_status_check;
ALTER TABLE pending_approvals ADD CONSTRAINT pending_approvals_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text, 'approved'::text, 'rejected'::text,
    'expired'::text, 'superseded'::text, 'auto_approved'::text
  ]));

COMMENT ON COLUMN public.pending_approvals.kind IS 'Approval taxonomy enforced at the application layer (see ApprovalKind in packages/api/src/db/pending-approvals-store.ts). Live kinds: workflow_step, tool_invocation, staged_write, distribution_draft, staged_skill_creation, staged_skill_update, browser_skill_send.';

COMMIT;
