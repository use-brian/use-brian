-- 352_goal_v1_draft_cleanup.sql
--
-- Task autopilot v2 data cleanup (docs/plans/task-goal-autopilot.md §8):
-- remove the v1 unconditional-auto-draft slop. Before v2, EVERY top-level task
-- minted a templated "Complete: <title>" goal; v2 replaced that with the
-- judge-gated brief-carrying draft, so the leftover v1 rows are pure noise on
-- the new triage surface (they would all appear under "Tasks assignable" with
-- no brief and a template outcome).
--
-- Class-scoped, never row-targeted:
--   1. v1 drafts: unconfirmed AND brief-less AND non-terminal. Every v2 draft
--      carries a brief and every explicitly-created goal (setGoal) is
--      confirmed at creation, so this predicate selects exactly the v1
--      template drafts. Terminal rows (done/abandoned — pre-confirm-gate-era
--      completions exist) are kept as history; they never surface on the
--      triage or autopilot panels.
--   2. v1 template-origin goals that were confirmed but died on the vine:
--      brief-less, template outcome, and either blocked (not executing by
--      definition) or active with NO means.workflowId (armed but never spun
--      up). A mid-loop goal always has means.workflowId and a running goal is
--      excluded entirely, so nothing live can match. done/abandoned rows are
--      kept as history.
--   3. Orphaned goal-tick scheduled jobs whose goal no longer exists (from
--      this delete or any earlier manual state) — a tick for a missing goal
--      only burns a poll cycle. The LIKE guard scopes the jsonb cast to rows
--      the goal driver wrote (buildGoalTick emits compact JSON), so plain
--      reminder instructions are never cast.

BEGIN;

DELETE FROM goals
 WHERE confirmed_at IS NULL
   AND brief IS NULL
   AND status NOT IN ('done', 'abandoned');

DELETE FROM goals
 WHERE confirmed_at IS NOT NULL
   AND brief IS NULL
   AND outcome LIKE 'Complete: %'
   AND (status = 'blocked' OR (status = 'active' AND (means ->> 'workflowId') IS NULL));

DELETE FROM scheduled_jobs
 WHERE instructions LIKE '%"kind":"goal_tick"%'
   AND NOT EXISTS (
     SELECT 1 FROM goals g WHERE g.id::text = (instructions::jsonb ->> 'goalId')
   );

COMMIT;
