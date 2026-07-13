-- 321_page_actions.sql
--
-- Page actions — human-approved dispatch from doc pages (buttons), plus the
-- verbatim-send idempotency ledger. Spec:
-- docs/architecture/features/page-actions.md (plan: docs/plans/page-actions.md).
--
-- Three parts:
--
--   1. `page_actions` — the button BINDINGS. Owned by the blueprint/page side
--      (NOT a workflow trigger kind): scope is exactly one of `blueprint_id`
--      (the button shows on every page projected from that blueprint, resolved
--      through `blueprint_records.page_id`) or `page_id` (that page only).
--      `action` is the discriminated union `{ kind: 'workflow' | 'goal', ... }`,
--      Zod-validated at the REST boundary.
--
--   2. `page_send_log` — the at-most-once send claim for `send_page` steps.
--      A claim row is inserted BEFORE the send; the partial unique index on
--      (page_id) over status IN ('claimed','sent') makes a second send of the
--      same page an insert conflict → idempotent `already_sent` no-op (or a
--      "send in flight" refusal while a fresh claim is active). `failed` rows
--      fall outside the index, so a failed send never blocks a retry.
--
--   3. `workflow_runs.trigger_kind` admits 'button' (mirror of mig 304's
--      DROP/ADD). Button runs are inline-advanced like manual — the run-queue
--      drainer keeps claiming ONLY 'event' — but the distinct kind is the
--      server-side gate `send_page` checks: every v1 external send has a
--      human click behind it.
--
-- Also: `blueprint_records (workspace_id, page_id)` index for the forward
-- button-resolve join (page → its record → blueprint-scoped buttons).

BEGIN;

-- ── 1. page_actions ─────────────────────────────────────────────────────

CREATE TABLE public.page_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    blueprint_id uuid,
    page_id uuid,
    label text NOT NULL,
    icon text,
    confirm_copy text,
    action jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    position integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_actions_pkey PRIMARY KEY (id),
    CONSTRAINT page_actions_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT page_actions_blueprint_id_fkey
        FOREIGN KEY (blueprint_id) REFERENCES public.workspace_page_templates(id) ON DELETE CASCADE,
    CONSTRAINT page_actions_page_id_fkey
        FOREIGN KEY (page_id) REFERENCES public.saved_views(id) ON DELETE CASCADE,
    -- Exactly one scope: blueprint-wide or single-page.
    CONSTRAINT page_actions_scope_check
        CHECK (num_nonnulls(blueprint_id, page_id) = 1),
    CONSTRAINT page_actions_label_check
        CHECK (((length(label) >= 1) AND (length(label) <= 64)))
);

CREATE INDEX page_actions_workspace_blueprint_idx
    ON public.page_actions (workspace_id, blueprint_id)
    WHERE blueprint_id IS NOT NULL;
CREATE INDEX page_actions_workspace_page_idx
    ON public.page_actions (workspace_id, page_id)
    WHERE page_id IS NOT NULL;

CREATE TRIGGER page_actions_set_updated_at
    BEFORE UPDATE ON public.page_actions
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.page_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY page_actions_workspace_member ON public.page_actions
    USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

-- ── 2. page_send_log ────────────────────────────────────────────────────

CREATE TABLE public.page_send_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    page_id uuid NOT NULL,
    workflow_id uuid,
    run_id uuid,
    recipient text NOT NULL,
    subject text NOT NULL,
    body_hash text,
    external_id text,
    status text DEFAULT 'claimed'::text NOT NULL,
    error text,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT page_send_log_pkey PRIMARY KEY (id),
    CONSTRAINT page_send_log_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
    CONSTRAINT page_send_log_status_check
        CHECK (status = ANY (ARRAY['claimed'::text, 'sent'::text, 'failed'::text]))
);

-- The at-most-once guarantee: one live claim/sent row per page. `failed`
-- rows fall outside the index so retries insert fresh claims.
CREATE UNIQUE INDEX page_send_log_page_live_idx
    ON public.page_send_log (page_id)
    WHERE status IN ('claimed', 'sent');
CREATE INDEX page_send_log_workspace_page_idx
    ON public.page_send_log (workspace_id, page_id, claimed_at DESC);

ALTER TABLE public.page_send_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY page_send_log_workspace_member ON public.page_send_log
    USING ((workspace_id IN ( SELECT workspace_members.workspace_id
       FROM public.workspace_members
      WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

-- ── 3. trigger_kind admits 'button'; step_type admits 'send_page' ───────

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind = ANY (ARRAY['manual'::text, 'schedule'::text, 'event'::text, 'button'::text]));

ALTER TABLE workflow_step_runs DROP CONSTRAINT workflow_step_runs_step_type_check;

ALTER TABLE workflow_step_runs
  ADD CONSTRAINT workflow_step_runs_step_type_check
  CHECK (step_type = ANY (ARRAY['assistant_call'::text, 'tool_call'::text, 'wait'::text, 'branch'::text, 'send_page'::text]));

-- ── 4. forward button-resolve join support ──────────────────────────────

CREATE INDEX blueprint_records_workspace_page_idx
    ON public.blueprint_records (workspace_id, page_id)
    WHERE page_id IS NOT NULL;

COMMIT;
