-- 366_archive_spent_oneoff_reminders.sql
--
-- One-time backfill: archive the fired-reminder backlog polluting the active
-- Workflow grid.
--
-- A one-off reminder ("remind me at 3pm") is a `schedule: { type: 'once' }`
-- workflow the assistant builds via createWorkflow, backed by a `scheduled_jobs`
-- trigger row. Once it fires it is spent and never runs again, but nothing
-- retired it: the fire-time archival (job-store `markCompleted`/`markFailed`)
-- and the `decideLifecycle` `isSpentOnceSchedule` fast path both ship in the
-- same change, and the background lifecycle sweep ships dark
-- (WORKFLOW_LIFECYCLE_ENABLED), so the existing backlog would otherwise never
-- leave the grid. This applies the same retirement to the rows already present.
--
-- Target: an `active`, unpinned, `schedule-once` workflow that has at least one
-- `scheduled_jobs` row pointing at it and NO enabled one — proof its single
-- fire is spent (a still-pending reminder has an enabled trigger row; hasLiveFire
-- protects it). Archival mirrors applyLifecycleTransitionSystem: sets
-- lifecycle_state='archived' and enabled=false. Reversible — users restore via
-- PATCH lifecycleState:'active'. Pinned rows and still-armed reminders are left
-- untouched. Older flotsam whose trigger row was already reaped by the 30-day
-- disabled-row GC has no `scheduled_jobs` row and is left for the sweep when it
-- is enabled.
--
-- Spec: docs/architecture/features/workflow-lifecycle.md -> "Spent one-off
-- schedules". `workflows` is an open-tree table.

BEGIN;

UPDATE public.workflows w
   SET lifecycle_state = 'archived',
       lifecycle_reason = 'One-off schedule completed (backfill 366)',
       lifecycle_transitioned_at = now(),
       enabled = false
 WHERE w.lifecycle_state = 'active'
   AND w.pinned = false
   AND w.trigger->>'kind' = 'schedule'
   AND w.trigger->'schedule'->>'type' = 'once'
   AND EXISTS (
         SELECT 1 FROM public.scheduled_jobs j
          WHERE j.workflow_id = w.id
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.scheduled_jobs j
          WHERE j.workflow_id = w.id
            AND j.enabled = true
       );

COMMIT;
