-- 287_goal_confirmed_at.sql
--
-- Task autopilot (docs/plans/task-goal-autopilot.md §4): the draft/confirm slop
-- gate. A goal auto-drafted on task creation starts UNCONFIRMED (confirmed_at
-- NULL); the creator confirms its detail to arm it. An unconfirmed (draft) goal
-- can never reach the acting loop or the rollup — slop can't burn money, and a
-- guessed done_when never auto-completes. Goals created explicitly (the setGoal
-- tool) are confirmed at creation.

BEGIN;

ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

COMMENT ON COLUMN public.goals.confirmed_at IS
  'NULL = draft (auto-minted on task create, unconfirmed). Set when the creator confirms the goal detail; required before the goal may act or roll up (task-goal-autopilot.md §4).';

COMMIT;
