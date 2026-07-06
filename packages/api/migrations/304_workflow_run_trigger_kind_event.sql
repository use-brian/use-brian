-- Add 'event' to the workflow_runs.trigger_kind CHECK.
--
-- The run-queue drain worker (mig 302) must claim ONLY event-dispatched runs.
-- Event runs were previously stamped trigger_kind='manual' (a shortcut — the
-- enum had no 'event' member), which made them indistinguishable from the
-- inline-advanced manual/schedule/goal runs that also sit momentarily in
-- status='pending'. The drainer, claiming any pending row, then resurrected
-- ~70 orphaned scheduled runs and re-fired a user's reminder (2026-07-06
-- storm). Event dispatch now stamps trigger_kind='event' and the queue's
-- claim + both reapers gate on it, so inline runs are permanently outside the
-- queue's reach. This migration admits the new value.
--
-- No backfill: event-source workflows are not yet firing in production (zero
-- 'event' runs exist), so there are no historical rows to reclassify. Existing
-- 'manual'/'schedule' rows are unaffected.
--
-- Spec: docs/architecture/features/workflow.md → "Event run queue" (Claiming:
-- queue-owned runs only). [COMP:workflow/run-queue]

BEGIN;

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind = ANY (ARRAY['manual'::text, 'schedule'::text, 'event'::text]));

COMMIT;
