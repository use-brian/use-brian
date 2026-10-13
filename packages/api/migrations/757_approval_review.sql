-- Explicitly delegated approval review, approval patterns, delegated
-- receipts, Chat attention seen-state and operational route bindings.
-- Spec: docs/architecture/features/approval-review.md
--
-- [COMP:api/approval-review-assignment] Owner-role safe; no backfill:
-- legacy workflows and requests gain no reviewer.
BEGIN;

-- ── Who decided ─────────────────────────────────────────────────────────────
ALTER TABLE public.pending_approvals
  ADD COLUMN resolution_origin text
    CHECK (resolution_origin IN ('human', 'delegated_assistant', 'standing_grant', 'system'));

-- ── Assignments ─────────────────────────────────────────────────────────────
CREATE TABLE public.approval_review_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  reviewer_assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  delegator_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('request', 'task', 'session', 'workflow', 'browser_skill')),
  scope_id uuid NOT NULL,
  parameter_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameter_policy) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  origin text NOT NULL CHECK (origin IN ('ui', 'chat')),
  instruction_receipt jsonb NOT NULL CHECK (jsonb_typeof(instruction_receipt) = 'object'),
  source_ceiling jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE UNIQUE INDEX approval_review_assignments_one_active
  ON public.approval_review_assignments (workspace_id, scope_kind, scope_id) WHERE status = 'active';
CREATE INDEX approval_review_assignments_reviewer
  ON public.approval_review_assignments (reviewer_assistant_id) WHERE status = 'active';

-- ── Patterns and human support ──────────────────────────────────────────────
CREATE TABLE public.approval_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  procedure_kind text NOT NULL CHECK (procedure_kind IN ('workflow', 'browser_skill')),
  procedure_id uuid NOT NULL,
  step_key text NOT NULL,
  action_kind text NOT NULL,
  identity_key text NOT NULL,
  descriptor jsonb NOT NULL,
  parameter_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'suspended', 'revoked')),
  version integer NOT NULL CHECK (version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  support_since timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  suspended_reason text,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'suspended' OR suspended_reason IS NOT NULL),
  UNIQUE (workspace_id, pattern_key, version)
);
-- One live lineage per key; a revoked lineage is history.
CREATE UNIQUE INDEX approval_patterns_one_live
  ON public.approval_patterns (workspace_id, pattern_key) WHERE status <> 'revoked';
CREATE INDEX approval_patterns_procedure
  ON public.approval_patterns (workspace_id, procedure_kind, procedure_id, step_key);

CREATE TABLE public.approval_pattern_support (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES public.approval_patterns(id) ON DELETE CASCADE,
  approval_id uuid NOT NULL REFERENCES public.pending_approvals(id) ON DELETE CASCADE,
  chain_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  human_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  source_session_id uuid,
  workflow_run_id uuid,
  UNIQUE (pattern_id, approval_id)
);
CREATE INDEX approval_pattern_support_pattern ON public.approval_pattern_support (pattern_id, decided_at);

-- ── Delegated receipts and attempts ─────────────────────────────────────────
CREATE TABLE public.approval_delegated_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  approval_id uuid NOT NULL UNIQUE REFERENCES public.pending_approvals(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.approval_review_assignments(id) ON DELETE CASCADE,
  assignment_revision integer NOT NULL,
  reviewer_assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  delegator_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES public.approval_patterns(id) ON DELETE CASCADE,
  pattern_version integer NOT NULL,
  pattern_revision bigint NOT NULL,
  support_approval_ids uuid[] NOT NULL CHECK (cardinality(support_approval_ids) >= 3),
  action_digest text NOT NULL,
  authority jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL)),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE public.approval_review_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  approval_id uuid NOT NULL REFERENCES public.pending_approvals(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES public.approval_review_assignments(id) ON DELETE SET NULL,
  reviewer_assistant_id uuid REFERENCES public.assistants(id) ON DELETE SET NULL,
  trigger text NOT NULL CHECK (trigger IN ('created', 'requested', 'reviewer_tool')),
  outcome text NOT NULL CHECK (outcome IN ('resolved', 'needs_human', 'blocked')),
  reasons text[] NOT NULL DEFAULT '{}',
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  pattern_id uuid REFERENCES public.approval_patterns(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_review_attempts_approval ON public.approval_review_attempts (approval_id, created_at DESC);

-- ── Chat attention seen-state ───────────────────────────────────────────────
CREATE TABLE public.approval_review_attention_seen (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  item_key text NOT NULL CHECK (length(item_key) <= 200),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, item_key)
);

-- ── Operational route bindings ──────────────────────────────────────────────
CREATE TABLE public.operational_route_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL UNIQUE REFERENCES public.workflows(id) ON DELETE CASCADE,
  intended jsonb NOT NULL CHECK (jsonb_typeof(intended) = 'object'),
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(alternatives) = 'array' AND jsonb_array_length(alternatives) <= 10),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.operational_route_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  workflow_run_id uuid,
  lost_route jsonb,
  outcome text NOT NULL CHECK (outcome IN ('selected', 'blocked')),
  selected_route jsonb,
  blocker text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'blocked') = (blocker IS NOT NULL))
);
CREATE INDEX operational_route_events_open ON public.operational_route_events (workspace_id, created_at DESC) WHERE outcome = 'blocked' AND resolved_at IS NULL;

-- ── RLS (SELECT only; writes use the owner pool behind the domain services) ─
ALTER TABLE public.approval_review_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_pattern_support ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_delegated_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_review_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_review_attention_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_route_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_route_events ENABLE ROW LEVEL SECURITY;

-- An assignment is visible only to members who can read its scope source
-- under that source's own policies.
CREATE POLICY approval_review_assignments_read ON public.approval_review_assignments FOR SELECT USING (
  workspace_id IN (SELECT m.workspace_id FROM public.workspace_members m
                    WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND CASE scope_kind
        WHEN 'workflow' THEN EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = approval_review_assignments.scope_id)
        WHEN 'browser_skill' THEN EXISTS (SELECT 1 FROM public.browser_skills b WHERE b.id = approval_review_assignments.scope_id)
        WHEN 'request' THEN EXISTS (SELECT 1 FROM public.pending_approvals p WHERE p.id = approval_review_assignments.scope_id)
        WHEN 'task' THEN EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = approval_review_assignments.scope_id)
        ELSE EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = approval_review_assignments.scope_id)
      END);

CREATE POLICY approval_patterns_read ON public.approval_patterns FOR SELECT USING (
  workspace_id IN (SELECT m.workspace_id FROM public.workspace_members m
                    WHERE m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  AND CASE procedure_kind
        WHEN 'workflow' THEN EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = approval_patterns.procedure_id)
        ELSE EXISTS (SELECT 1 FROM public.browser_skills b WHERE b.id = approval_patterns.procedure_id)
      END);

-- Support is a reference to a human decision; it is readable only while
-- both the pattern and the original request are.
CREATE POLICY approval_pattern_support_read ON public.approval_pattern_support FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.approval_patterns p WHERE p.id = approval_pattern_support.pattern_id)
  AND EXISTS (SELECT 1 FROM public.pending_approvals a WHERE a.id = approval_pattern_support.approval_id));

CREATE POLICY approval_delegated_resolutions_read ON public.approval_delegated_resolutions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.pending_approvals a WHERE a.id = approval_delegated_resolutions.approval_id));

CREATE POLICY approval_review_attempts_read ON public.approval_review_attempts FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.pending_approvals a WHERE a.id = approval_review_attempts.approval_id));

CREATE POLICY approval_review_attention_seen_own ON public.approval_review_attention_seen FOR SELECT USING (
  user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY operational_route_bindings_read ON public.operational_route_bindings FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = operational_route_bindings.workflow_id));

CREATE POLICY operational_route_events_read ON public.operational_route_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = operational_route_events.workflow_id));

COMMIT;
