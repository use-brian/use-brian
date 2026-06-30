-- 285_goals.sql
--
-- Goals: the first-class, host-polymorphic, self-terminating Noun (the
-- goal-seeker primitive). See docs/plans/task-goal-seeker.md §3.2 / §4.
--
-- OPERATIONAL table (mutable status, like workflow_runs) — NOT a bi-temporal /
-- MLS brain primitive like tasks. One workspace-member RLS policy (mirrors
-- workflow_runs). Engine/system writes go through the owner pool (`query()`);
-- user reads through the app pool (`queryWithRLS`). The route handler / engine
-- is the authorization gate on writes.
--
--   host_type / host_id : the polymorphic binding. BOTH null = self-hosted (the
--                         goal is its own subject). host_id is intentionally NOT
--                         a FK (it points at task|page|entity|workflow); the host
--                         adapter resolves it and a dangling host fails legibly.
--   parent_goal_id      : sub-goal trees (a parent's done_when can be "all
--                         sub-goals done"). CASCADE — deleting a goal removes
--                         its sub-tree.
--   recipe_id           : the goal_recipes Spec that minted this goal. The
--                         recipe table lands in a later slice; the FK is added
--                         then (plain uuid column for now).
--   done_when           : the engine-verifiable predicate tree (goals/done-when).
--   means / budget / policy : §3.2.

BEGIN;

CREATE TABLE IF NOT EXISTS public.goals (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  parent_goal_id uuid REFERENCES public.goals(id) ON DELETE CASCADE,
  recipe_id uuid,
  host_type text,
  host_id uuid,
  outcome text NOT NULL,
  done_when jsonb NOT NULL,
  means jsonb DEFAULT '{}'::jsonb NOT NULL,
  policy jsonb DEFAULT '{}'::jsonb NOT NULL,
  budget jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  blocker_reason text,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT goals_pkey PRIMARY KEY (id),
  CONSTRAINT goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'running'::text, 'awaiting_approval'::text, 'blocked'::text, 'done'::text, 'abandoned'::text]))),
  CONSTRAINT goals_host_type_check CHECK ((host_type IS NULL) OR (host_type = ANY (ARRAY['task'::text, 'page'::text, 'entity'::text, 'workflow'::text]))),
  -- host_type and host_id are both-or-neither: both null = self-hosted.
  CONSTRAINT goals_host_pairing_check CHECK (((host_type IS NULL) AND (host_id IS NULL)) OR ((host_type IS NOT NULL) AND (host_id IS NOT NULL))),
  CONSTRAINT goals_outcome_check CHECK (((length(outcome) >= 1) AND (length(outcome) <= 2000)))
);

-- Primary "active goals in this workspace" + per-status sweeps.
CREATE INDEX IF NOT EXISTS idx_goals_workspace_status ON public.goals USING btree (workspace_id, status);
-- The rollup / host lookup: "which goal(s) drive this task?".
CREATE INDEX IF NOT EXISTS idx_goals_host ON public.goals USING btree (host_type, host_id) WHERE (host_id IS NOT NULL);
-- Sub-goal fan-out.
CREATE INDEX IF NOT EXISTS idx_goals_parent ON public.goals USING btree (parent_goal_id) WHERE (parent_goal_id IS NOT NULL);
-- The goals board "active" sweep (most-recently-touched first).
CREATE INDEX IF NOT EXISTS idx_goals_workspace_active ON public.goals USING btree (workspace_id, updated_at DESC) WHERE (status <> ALL (ARRAY['done'::text, 'abandoned'::text]));

-- Cross-workspace parent guard (mirrors tasks_parent_workspace_match): a user
-- in two workspaces must not parent a child goal onto a goal in another.
CREATE OR REPLACE FUNCTION public.goals_parent_workspace_match() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_goal_id IS NOT NULL
     AND (SELECT workspace_id FROM public.goals WHERE id = NEW.parent_goal_id) <> NEW.workspace_id THEN
    RAISE EXCEPTION 'goals.parent_goal_id must reference a goal in the same workspace';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS goals_parent_workspace_match_trg ON public.goals;
CREATE TRIGGER goals_parent_workspace_match_trg
  BEFORE INSERT OR UPDATE OF parent_goal_id, workspace_id ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.goals_parent_workspace_match();

DROP TRIGGER IF EXISTS goals_set_updated_at_trg ON public.goals;
CREATE TRIGGER goals_set_updated_at_trg
  BEFORE UPDATE ON public.goals
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goals_workspace_member ON public.goals;
CREATE POLICY goals_workspace_member ON public.goals USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

COMMIT;
