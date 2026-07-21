-- 347_goal_brief.sql
--
-- Task autopilot v2 (docs/plans/task-goal-autopilot.md §8): triaged drafting.
-- A draft goal is no longer a template restatement — the task-create judge
-- generates a brief ({verification, approach, judgeReason}) alongside the
-- outcome, persisted here. NULL = pre-v2 goal or an explicitly-created goal
-- (setGoal) with no brief. done_when is unchanged (hostTaskDone stays the
-- objective terminal); the brief is advisory context threaded into the
-- completion workflow input and reviewed by the confirm clarity gate.

BEGIN;

ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS brief jsonb;

COMMENT ON COLUMN public.goals.brief IS
  'Triage brief from the task-create judge: {verification, approach, judgeReason}. NULL = no brief (pre-v2 row or explicit setGoal). Advisory — done_when remains the terminal predicate (task-goal-autopilot.md §8).';

COMMIT;
