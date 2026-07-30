-- 383_goal_host_task_cascade_backfill.sql
--
-- Backfill for the goal host-lifecycle cascade
-- (docs/architecture/features/goals.md → "Host-lifecycle cascade").
--
-- `goals.host_id` is deliberately not a FK, so no code path retired the goals
-- bound to a task that left the live set. Every task delete since the autopilot
-- v2 draft path shipped therefore stranded its judge-drafted goal: unconfirmed,
-- non-terminal, and permanently parked on the "Tasks assignable" triage surface
-- and its home-dock count. One workspace had 242 such drafts on 2026-07-30 —
-- 224 of them hosted on a task the user had already deleted, 14 on a task they
-- had already finished — against 4 that were genuinely assignable.
--
-- The forward fix cascades on delete (`abandonGoalsForHostTaskSystem`, called
-- from the brain-inbox single + bulk delete lanes and `rejectTask`) and on close
-- (`updateTask`, drafts only). This clears what accumulated before it.
--
-- Class-scoped, never row-targeted — the predicates are "host task is gone" and
-- "host task is closed and the goal is still a draft", not any workspace or id:
--
--   1. Host task not live: no row at all, or its live version is soft-deleted
--      (`valid_to IS NOT NULL AND superseded_by IS NULL` — a superseded row is
--      an EDIT, and `updateTask` repoints `host_id` onto the new version, so a
--      normally-edited task never matches). Every non-terminal goal goes: with
--      the host gone a confirmed goal can never reach `hostTaskDone` either.
--   2. Host task live but terminal (`done` / `archived`), goal still a DRAFT.
--      "Your assistant can help with this" is meaningless on work the user has
--      already finished or filed away. Confirmed goals are untouched here — a
--      confirmed goal whose host closed is the goal succeeding, and completing
--      it belongs to the rollup / acting loop, not to this migration.
--
--   3. Enabled goal-tick jobs whose goal is terminal (including the rows the two
--      statements above just retired). A tick cannot claim a terminal goal
--      (`tryClaimGoalForTick` requires `active`), so the job is inert — it only
--      burns a poll cycle. The LIKE guard scopes the match to rows the goal
--      driver wrote (`buildGoalTick` emits compact JSON), same shape as 352.
--
-- `running` goals are excluded from statements 1 and 2: the acting loop owns a
-- claimed goal (single-flight) and would re-arm over the write. Terminal rows are
-- left as history — they surface nowhere.
--
-- Retire, don't delete: the task itself is only soft-deleted, so the goal
-- follows with the same reversible discard the Dismiss button writes
-- (`status='abandoned'`), and the judge's brief survives as history.

BEGIN;

UPDATE goals g
   SET status = 'abandoned', blocker_reason = 'host_task_deleted'
 WHERE g.host_type = 'task'
   AND g.status NOT IN ('done', 'abandoned', 'running')
   AND NOT EXISTS (
     SELECT 1 FROM tasks t WHERE t.id = g.host_id AND t.valid_to IS NULL
   );

UPDATE goals g
   SET status = 'abandoned', blocker_reason = 'host_task_closed'
 WHERE g.host_type = 'task'
   AND g.confirmed_at IS NULL
   AND g.status NOT IN ('done', 'abandoned', 'running')
   AND EXISTS (
     SELECT 1 FROM tasks t
      WHERE t.id = g.host_id AND t.valid_to IS NULL
        AND t.status IN ('done', 'archived')
   );

DELETE FROM scheduled_jobs j
 WHERE j.enabled = true
   AND j.channel_type = 'workflow'
   AND j.instructions LIKE '{"kind":"goal_tick"%'
   AND EXISTS (
     SELECT 1 FROM goals g
      WHERE g.id::text = j.channel_id
        AND g.status IN ('done', 'abandoned')
   );

COMMIT;
