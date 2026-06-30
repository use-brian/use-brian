-- 286_goal_recipes.sql
--
-- Goal recipes: the one earned Spec (reusable, {{var}}-parameterized goal
-- blueprints) — see docs/architecture/features/goals.md and
-- docs/plans/task-goal-seeker.md §3.6. Workspace-shared, like saved_views /
-- workspace_page_templates. The minted goal's `goals.recipe_id` FKs back here
-- (the deferred FK from 285_goals.sql).

BEGIN;

CREATE TABLE IF NOT EXISTS public.goal_recipes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  outcome text NOT NULL,
  done_when jsonb NOT NULL,
  means jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  vars jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT goal_recipes_pkey PRIMARY KEY (id),
  CONSTRAINT goal_recipes_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)))
);

CREATE INDEX IF NOT EXISTS idx_goal_recipes_workspace ON public.goal_recipes USING btree (workspace_id, updated_at DESC);

DROP TRIGGER IF EXISTS goal_recipes_set_updated_at_trg ON public.goal_recipes;
CREATE TRIGGER goal_recipes_set_updated_at_trg
  BEFORE UPDATE ON public.goal_recipes
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.goal_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goal_recipes_workspace_member ON public.goal_recipes;
CREATE POLICY goal_recipes_workspace_member ON public.goal_recipes USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid))));

-- The deferred goals.recipe_id FK (285 left it a plain column until this table existed).
ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_recipe_id_fkey;
ALTER TABLE public.goals ADD CONSTRAINT goals_recipe_id_fkey
  FOREIGN KEY (recipe_id) REFERENCES public.goal_recipes(id) ON DELETE SET NULL;

COMMIT;
