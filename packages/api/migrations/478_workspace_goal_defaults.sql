-- Workspace-configurable default budget for future autonomous goal kickoffs.
-- Explicit per-goal budgets remain stored on `goals.budget` and always win.

BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_goal_defaults (
  workspace_id UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  max_iterations INTEGER NOT NULL CHECK (max_iterations > 0 AND max_iterations <= 1000),
  max_spend_usd NUMERIC(18,10) NOT NULL CHECK (max_spend_usd > 0),
  updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.workspace_goal_defaults IS
  'Workspace override copied onto a budget-less acting goal at kickoff.';
COMMENT ON COLUMN public.workspace_goal_defaults.max_spend_usd IS
  'Brian COGS cap in USD. User-funded/BYOK calls carry zero Brian COGS.';

COMMIT;
